// Cliente de eventos do motor local → backend (rotas internas).
//
// Porta do webapp/worker/events_client.py: acumula eventos e envia em lotes a
// cada ~700ms para POST /internal/jobs/{id}/events (X-Worker-Token). O backend
// atribui o seq, persiste e faz o broadcast — o site mostra ao vivo.
//
// Cancelamento: a resposta do POST informa o status do job; quando vier
// "cancelled", a flag `cancelled` acende e o worker mata o processo do Claude.
// Mesmo sem eventos novos, um POST vazio de heartbeat sai a cada ~2.5s.

'use strict';

const FLUSH_INTERVAL_MS = 700;
const HEARTBEAT_INTERVAL_MS = 2500;
const MAX_PENDING = 2000; // proteção de memória se o backend ficar fora do ar

const FETCH_TIMEOUT_MS = 15000; // conexão muda não pode pendurar o heartbeat

class EventsClient {
  constructor(backendUrl, workerToken, jobId, log) {
    this._url = `${backendUrl.replace(/\/+$/, '')}/internal/jobs/${jobId}/events`;
    this._headers = { 'X-Worker-Token': workerToken, 'Content-Type': 'application/json' };
    this._pending = [];
    this._timer = null;
    this._lastPost = 0;
    this._flushPromise = null; // flush em voo (para o stop aguardar, não pular)
    this.cancelled = false;
    this._log = log || (() => {});
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this._flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
  }

  emit(tipo, payload) {
    if (this._pending.length >= MAX_PENDING) this._pending.shift();
    this._pending.push({ tipo, payload });
  }

  /** Para o loop e faz o flush final do que restou na fila.
   *  AGUARDA um flush em voo antes do flush forçado — pular o final quando o
   *  timer disparou há pouco perderia os últimos eventos (ex.: 'resultado'). */
  async stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try {
      if (this._flushPromise) await this._flushPromise.catch(() => {});
      await this._flush(true);
    } catch {
      this._log('Flush final de eventos falhou (últimos eventos podem se perder)');
    }
  }

  _flush(force = false) {
    if (this._flushPromise) {
      // Sem flushes concorrentes: o lote atual sai no próximo tick (ou no
      // stop, que aguarda este e força outro).
      return force ? this._flushPromise.then(() => this._doFlush(true)) : Promise.resolve();
    }
    const p = this._doFlush(force).finally(() => {
      if (this._flushPromise === p) this._flushPromise = null;
    });
    this._flushPromise = p;
    return p;
  }

  async _doFlush(force) {
    const batch = this._pending;
    this._pending = [];

    const now = Date.now();
    if (!batch.length && !force && (now - this._lastPost) < HEARTBEAT_INTERVAL_MS) {
      return; // nada a enviar e heartbeat ainda não venceu
    }

    let resp;
    try {
      resp = await fetch(this._url, {
        method: 'POST',
        headers: this._headers,
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      // Rede caiu/timeout: re-enfileira na frente para não perder ordem.
      if (batch.length) this._pending = batch.concat(this._pending);
      return;
    }
    this._lastPost = Date.now();

    if (resp.status >= 500) {
      if (batch.length) this._pending = batch.concat(this._pending);
      return;
    }
    if (resp.status >= 400) {
      // Erro de cliente (job sumiu, token inválido): re-tentar não resolve.
      this._log(`Backend rejeitou eventos (${resp.status})`);
      return;
    }
    const data = await resp.json().catch(() => null);
    if (data && (data.status === 'cancelled' || data.cancelado === true)) {
      this.cancelled = true;
    }
  }
}

module.exports = { EventsClient };
