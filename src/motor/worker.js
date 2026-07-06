// Motor local do Offiz Standalone — o worker que roda na máquina do cliente.
//
// Mesmo contrato do worker cloud (webapp/worker/runner.py), com UMA diferença
// estrutural: o workspace vive no SERVIDOR. O claim devolve caminhos de disco
// do servidor (inúteis aqui), então o motor:
//   1. reivindica um job da SUA org (token offiz_wk_..., escopado no backend);
//   2. baixa o workspace inteiro (GET /internal/jobs/{id}/workspace.zip) para
//      um diretório local, limpo a cada job (o servidor é a fonte da verdade);
//   3. roda o Claude Code CLI local (modo cli = login/assinatura do cliente);
//   4. envia eventos ao vivo (o site mostra em tempo real);
//   5. sobe os outputs novos e a memoria/ alterada de volta ao servidor;
//   6. finaliza (POST finish) — entregas/custo aparecem no site normalmente.
//
// Um job por vez (concurrency 1): é a máquina do cliente.

'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { internal, baixarWorkspaceZip, uploadArquivo } = require('./backend-client');
const { EventsClient } = require('./events-client');
const { spawnClaude, killProcessTree, StreamJsonParser } = require('./claude-runtime');

const POLL_INTERVAL_MS = 2000;      // fila vazia → novo claim em 2s
const CLAIM_ERROR_BACKOFF_MS = 5000; // backend inacessível → 5s
const WATCHDOG_TICK_MS = 500;
const MAX_LOG_LINES = 300;

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extrai um zip com ferramentas do SO (sem dependências npm):
 *  tar -xf (bsdtar: Windows 10+ e macOS aceitam zip) com fallback
 *  Expand-Archive (Windows) / unzip (unix). */
function extrairZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
  if (r.status === 0) return;
  if (process.platform === 'win32') {
    r = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { windowsHide: true });
  } else {
    r = spawnSync('unzip', ['-o', zipPath, '-d', destDir]);
  }
  if (r.status !== 0) {
    throw new Error(`Falha ao extrair o workspace (${zipPath}): tar/fallback retornaram erro`);
  }
}

/** Snapshot dos arquivos sob `wsDir/subdir`: Map<caminho_rel, {tamanho, mtimeMs}>.
 *
 *  A detecção de "novos outputs" compara snapshots (antes × depois do job) em
 *  vez de mtime × relógio: os timestamps DENTRO do zip vêm em hora LOCAL do
 *  servidor (formato DOS) e o cliente pode estar em outro fuso — comparar com
 *  o relógio local re-registraria outputs antigos como entregas novas. */
function snapshotArquivos(wsDir, subdir) {
  const base = path.join(wsDir, subdir);
  const mapa = new Map();
  if (!fs.existsSync(base)) return mapa;
  const walk = (dir) => {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        mapa.set(path.relative(wsDir, p).split(path.sep).join('/'), {
          tamanho: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
  };
  walk(base);
  return mapa;
}

/** Diferença entre snapshots: arquivos que nasceram ou mudaram durante o job. */
function arquivosNovosOuAlterados(wsDir, subdir, antes) {
  const depois = snapshotArquivos(wsDir, subdir);
  const out = [];
  for (const [rel, st] of depois) {
    const velho = antes.get(rel);
    if (!velho || velho.tamanho !== st.tamanho || velho.mtimeMs !== st.mtimeMs) {
      out.push({
        caminho_rel: rel,
        nome: path.basename(rel),
        tamanho: st.tamanho,
        local: path.join(wsDir, rel.split('/').join(path.sep)),
      });
    }
  }
  return out;
}

class MotorWorker extends EventEmitter {
  /**
   * opts: { getBackendUrl(), getWorkerToken(), getClaudeBin(), workspacesRoot }
   */
  constructor(opts) {
    super();
    this._opts = opts;
    this._running = false;
    this._stopping = false; // stop() em andamento — bloqueia start() até o loop antigo morrer
    this._loopPromise = null;
    this._jobAtual = null;
    this._logLines = [];
    this.workerId = `standalone-${os.hostname()}-${process.pid}`;
  }

  get estado() {
    if (!this._running) return 'parado';
    return this._jobAtual ? 'executando' : 'ocioso';
  }

  get jobAtual() { return this._jobAtual; }
  get logLines() { return this._logLines.slice(-60); }

  log(msg) {
    const linha = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`;
    this._logLines.push(linha);
    if (this._logLines.length > MAX_LOG_LINES) this._logLines.shift();
    this.emit('update');
  }

  start() {
    // _stopping: um stop() ainda espera o loop antigo terminar o job — ligar
    // agora criaria um SEGUNDO loop concorrente (dois claims, dois Claude).
    if (this._running || this._stopping) {
      if (this._stopping) this.log('Aguarde o motor terminar de desligar antes de ligar de novo.');
      return;
    }
    this._running = true;
    this.log(`Motor ligado (${this.workerId})`);
    this._loopPromise = this._loop().catch((e) => {
      this.log(`Loop do motor morreu: ${e.message}`);
      this._running = false;
      this.emit('update');
    });
    this.emit('update');
  }

  async stop() {
    if (!this._running || this._stopping) return;
    this._running = false;
    this._stopping = true;
    this.log('Motor desligando (aguarda o job atual terminar)…');
    this.emit('update');
    try {
      if (this._loopPromise) await this._loopPromise;
    } finally {
      this._stopping = false;
      this._loopPromise = null;
    }
    this.log('Motor desligado.');
    this.emit('update');
  }

  async _loop() {
    while (this._running) {
      const backendUrl = this._opts.getBackendUrl();
      const token = this._opts.getWorkerToken();
      if (!backendUrl || !token) {
        this.log('Sem pareamento (URL do backend ou token ausente) — motor em espera.');
        await _sleep(CLAIM_ERROR_BACKOFF_MS);
        continue;
      }

      let claim;
      try {
        claim = await internal(backendUrl, token, 'POST', '/jobs/claim', {
          worker_id: this.workerId,
        });
      } catch (e) {
        this.log(`Claim falhou (${e.message}) — nova tentativa em 5s`);
        await _sleep(CLAIM_ERROR_BACKOFF_MS);
        continue;
      }
      if (!claim || !claim.job) {
        await _sleep(POLL_INTERVAL_MS);
        continue;
      }
      await this._runJob(backendUrl, token, claim);
    }
  }

  async _runJob(backendUrl, token, claim) {
    const job = claim.job;
    this._jobAtual = {
      id: job.id,
      titulo: String(job.prompt || '').slice(0, 80),
      office: job.office_slug,
      org: job.org_id,
      inicio: Date.now(),
    };
    this.log(`Job #${job.id} (org ${job.org_id} · ${job.office_slug}) — iniciando`);
    this.emit('update');

    // Workspace local: limpo a cada job; o zip do servidor é a fonte da verdade.
    const wsDir = path.join(
      this._opts.workspacesRoot, `org-${job.org_id}`, String(job.office_slug)
    );

    const events = new EventsClient(backendUrl, token, job.id, (m) => this.log(m));
    const parser = new StreamJsonParser();
    let status = 'done';
    let erro = null;
    let proc = null;
    const stderrTail = [];
    const killReason = {};
    const inicio = Date.now();

    // Snapshots pós-extração: a detecção de outputs/memoria novos compara
    // antes × depois (nunca mtime × relógio — fuso do zip enganaria).
    let snapOutputs = new Map();
    let snapMemoria = new Map();

    try {
      // 1) workspace: baixa e extrai
      fs.rmSync(wsDir, { recursive: true, force: true });
      const zipTmp = path.join(os.tmpdir(), `offiz-ws-${job.id}-${Date.now()}.zip`);
      await baixarWorkspaceZip(backendUrl, token, job.id, zipTmp);
      extrairZip(zipTmp, wsDir);
      try { fs.rmSync(zipTmp, { force: true }); } catch { /* tmp */ }
      this.log(`Workspace do prédio baixado (${wsDir})`);
      snapOutputs = snapshotArquivos(wsDir, 'outputs');
      snapMemoria = snapshotArquivos(wsDir, 'memoria');

      events.start();

      // 2) spawn do Claude local
      proc = spawnClaude({
        workspaceDir: wsDir,
        prompt: String(job.prompt || ''),
        model: String(job.claude_model || 'claude-opus-4-8'),
        effort: job.effort,
        sessionId: String(job.session_id || ''),
        anthropicApiKey: claim.anthropic_api_key || '',
        motorModo: String(claim.motor_modo || 'cli'),
        claudeBin: this._opts.getClaudeBin(),
      });
      this.log(`Claude rodando (modo ${claim.motor_modo || 'cli'}, effort ${job.effort})`);

      proc.stderr.setEncoding('utf-8');
      proc.stderr.on('data', (chunk) => {
        for (const l of String(chunk).split(/\r?\n/)) {
          if (!l.trim()) continue;
          stderrTail.push(l.trim());
          if (stderrTail.length > 30) stderrTail.shift();
        }
      });

      // 3) watchdog: cancelamento (via resposta dos eventos) + timeout.
      // Dispara o kill UMA vez e se desarma — killProcessTree é assíncrono e
      // o 'close' do processo encerra o fluxo normalmente.
      const timeoutMin = Number(claim.timeout_min) > 0 ? Number(claim.timeout_min) : 30;
      const deadline = inicio + timeoutMin * 60 * 1000;
      const watchdog = setInterval(() => {
        if (events.cancelled) {
          killReason.reason = 'cancelled';
        } else if (Date.now() > deadline) {
          killReason.reason = 'timeout';
        } else {
          return;
        }
        clearInterval(watchdog);
        killProcessTree(proc);
      }, WATCHDOG_TICK_MS);

      // 4) stdout NDJSON → eventos do contrato
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (chunk) => {
        for (const ev of parser.feed(chunk)) events.emit(ev.tipo, ev.payload);
      });

      const rc = await new Promise((resolve) => {
        proc.on('close', (code) => resolve(code));
        proc.on('error', (e) => {
          erro = `Falha ao iniciar o Claude: ${e.message}`;
          resolve(-1);
        });
      });
      clearInterval(watchdog);
      for (const ev of parser.close()) events.emit(ev.tipo, ev.payload);

      if (killReason.reason === 'cancelled') {
        status = 'cancelled';
      } else if (killReason.reason === 'timeout') {
        status = 'failed';
        erro = `Tempo limite de ${timeoutMin} minutos excedido.`;
      } else if (parser.resultInfo && parser.resultInfo.is_error) {
        status = 'failed';
        erro = parser.resultInfo.erro || 'O Claude terminou com erro.';
      } else if (rc !== 0 && !erro) {
        status = 'failed';
        const detalhe = stderrTail.slice(-5).join(' | ').trim();
        erro = `Processo do Claude terminou com código ${rc}.` +
          (detalhe ? ` Detalhe: ${detalhe.slice(0, 400)}` : '');
      } else if (erro) {
        status = 'failed';
      }
    } catch (e) {
      status = 'failed';
      erro = `Falha no motor local: ${e.message}`;
    } finally {
      if (proc) killProcessTree(proc);
      if (erro) events.emit('erro', { mensagem: erro });

      // 5) sobe outputs novos + memoria alterada ANTES do finish. Só o que
      // subiu COM SUCESSO entra em novos_outputs — senão o site registraria
      // uma entrega apontando para arquivo que não existe no servidor.
      const outputsOk = [];
      try {
        const novos = arquivosNovosOuAlterados(wsDir, 'outputs', snapOutputs);
        const memoria = arquivosNovosOuAlterados(wsDir, 'memoria', snapMemoria);
        for (const f of novos) {
          try {
            await uploadArquivo(backendUrl, token, job.id, f.caminho_rel, f.local);
            outputsOk.push(f);
          } catch (e) {
            this.log(`Output ficou de fora da entrega (upload falhou): ${e.message}`);
          }
        }
        for (const f of memoria) {
          try {
            await uploadArquivo(backendUrl, token, job.id, f.caminho_rel, f.local);
          } catch (e) {
            this.log(e.message);
          }
        }
        if (outputsOk.length) {
          this.log(`${outputsOk.length} output(s) enviados ao servidor`);
        }
      } catch (e) {
        this.log(`Detecção/upload de outputs falhou: ${e.message}`);
      }

      await events.stop(); // flush final antes do finish

      const info = parser.resultInfo || {};
      const finishBody = {
        status,
        erro,
        tokens_entrada: parseInt(info.tokens_entrada, 10) || 0,
        tokens_saida: parseInt(info.tokens_saida, 10) || 0,
        custo_brl: Number(info.custo_brl) || 0,
        novos_outputs: outputsOk.map(({ caminho_rel, nome, tamanho }) => ({
          caminho_rel, nome, tamanho,
        })),
      };
      // finish com re-tentativas (é o que vira entregas/custo — não pode se perder)
      let entregue = false;
      for (let tentativa = 1; tentativa <= 5 && !entregue; tentativa++) {
        try {
          await internal(backendUrl, token, 'POST', `/jobs/${job.id}/finish`, finishBody);
          entregue = true;
        } catch (e) {
          if (e.status && e.status >= 400 && e.status < 500) {
            this.log(`Backend rejeitou finish (${e.status}: ${e.message})`);
            break;
          }
          await _sleep(Math.min(2000 * tentativa, 8000));
        }
      }

      this.log(`Job #${job.id} finalizado: ${status}${erro ? ` (${erro})` : ''}`);
      this._jobAtual = null;
      this.emit('update');
    }
  }
}

module.exports = { MotorWorker, extrairZip, snapshotArquivos, arquivosNovosOuAlterados };
