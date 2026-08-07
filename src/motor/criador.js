// O CRIADOR DE ESCRITÓRIOS — a sessão de edição por conversa, no app desktop.
//
// A forma (decisão do dono, 07/08/2026): "quase um Claude Code" — Claude de um
// lado, o escritório do outro. Este módulo é o lado do Claude: uma sessão
// MULTI-TURNO do Claude Code CLI local sobre uma cópia de trabalho do
// escritório, com os eventos streamados para a página e a publicação de volta
// ao catálogo quando o consultor aprovar.
//
// O ciclo (nenhuma rota nova no backend — reusa as do zip):
//   abrir(slug)   → GET /api/v1/admin/offices/{slug}/download (JWT do site)
//                   → extrai em <root>/criador/<slug>/escritorio/
//                   → escreve o CLAUDE.md do CRIADOR na raiz da pasta de
//                     trabalho (persona de editor — NÃO a persona do office)
//   enviar(texto) → claude -p ... --session-id S (1º turno) / --resume S
//                   (turnos seguintes), cwd na pasta de trabalho; eventos
//                   agent_text/tool_use/subagente/resultado via parser do
//                   claude-runtime + um evento 'manifesto' ao fim do turno
//   publicar()    → zipa escritorio/ e POST /api/v1/admin/offices/{slug}
//                   (multipart, JWT) — vale na hora, e o servidor revalida
//
// Credencial: SEMPRE modo 'cli' (login local do consultor). O criador é
// ferramenta nossa; nunca roda na chave de cliente.
//
// Por que a pasta de trabalho tem DOIS níveis (workDir/ + workDir/escritorio/):
// o CLAUDE.md do escritório é a persona de OPERÁRIO dele ("você é o chefe do
// escritório de conteúdo…"). Uma sessão de EDIÇÃO não pode vestir essa
// persona — ela edita o escritório, não trabalha nele. O CLAUDE.md da raiz é
// o do criador, e o do escritório vira só mais um arquivo editável.

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  resolveClaudeCmd,
  buildClaudeEnv,
  killProcessTree,
  StreamJsonParser,
} = require('./claude-runtime');
const { extrairZip, tarBin } = require('./worker');

const TIMEOUT_TURNO_MIN = 20;    // um turno de edição não é um job de 30min
const TIMEOUT_ZIP_MS = 180000;
const TIMEOUT_PUBLICAR_MS = 120000;

function _base(url) {
  return String(url || '').replace(/\/+$/, '');
}

/** Argumentos do CLI para UM turno da sessão do criador.
 *  1º turno: --session-id fixa o id; seguintes: --resume continua a MESMA
 *  conversa (é o que faz o criador ser multi-turno — o worker de jobs é
 *  one-shot e nunca precisou disso). --model só quando pedido: o default é o
 *  que o consultor configurou no próprio CLI dele. */
function buildArgsTurno({ sessionId, primeiroTurno, model, effort }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];
  if (primeiroTurno) args.push('--session-id', sessionId);
  else args.push('--resume', sessionId);
  if (model) args.push('--model', String(model));
  if (effort) args.push('--effort', String(effort));
  return args;
}

/** Snapshot (tamanho+mtime) de TODOS os arquivos sob dir — a lista de
 *  "o que a sessão mudou" compara contra o snapshot da abertura. */
function _snapshot(dir) {
  const mapa = new Map();
  if (!fs.existsSync(dir)) return mapa;
  const walk = (d) => {
    for (const nome of fs.readdirSync(d)) {
      const p = path.join(d, nome);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        mapa.set(path.relative(dir, p).split(path.sep).join('/'), {
          tamanho: st.size, mtimeMs: st.mtimeMs,
        });
      }
    }
  };
  walk(dir);
  return mapa;
}

/** Zipa o CONTEÚDO de `dir` (office.json na raiz — o formato que o POST do
 *  backend espera). tar -a (bsdtar, presente no Windows 10+ e macOS) decide o
 *  formato pela extensão; fallback Compress-Archive/zip. */
function ziparPasta(dir, zipDestino) {
  fs.rmSync(zipDestino, { force: true });
  let r = spawnSync(tarBin(), ['-a', '-cf', zipDestino, '-C', dir, '.'], { windowsHide: true });
  if (r.status === 0 && fs.existsSync(zipDestino)) return;
  if (process.platform === 'win32') {
    r = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${zipDestino.replace(/'/g, "''")}' -Force`,
    ], { windowsHide: true });
  } else {
    r = spawnSync('zip', ['-qr', zipDestino, '.'], { cwd: dir });
  }
  if (r.status !== 0 || !fs.existsSync(zipDestino)) {
    throw new Error('Não consegui empacotar o escritório (tar/fallback falharam).');
  }
}

class CriadorSessao extends EventEmitter {
  /** opts: { root (pasta base p/ sessões), claudeBin?: string|null } */
  constructor(opts) {
    super();
    this._root = opts.root;
    this._claudeBin = opts.claudeBin || null;
    this._slug = null;
    this._workDir = null;
    this._officeDir = null;
    this._sessionId = null;
    this._turnos = 0;
    this._proc = null;
    this._ocupado = false;
    this._snapAbertura = new Map();
  }

  get slug() { return this._slug; }
  get ocupado() { return this._ocupado; }
  get aberta() { return Boolean(this._slug); }

  _emitir(tipo, payload) { this.emit('evento', { tipo, payload }); }

  /** Baixa o escritório VIGENTE e monta a pasta de trabalho. Sempre começa
   *  limpo: o catálogo é a fonte da verdade, igual ao worker de jobs. */
  async abrir({ backendUrl, jwt, slug }) {
    if (this._ocupado) throw new Error('A sessão está no meio de um turno.');
    slug = String(slug || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) throw new Error('Slug inválido.');

    const resp = await fetch(
      `${_base(backendUrl)}/api/v1/admin/offices/${slug}/download`,
      { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(TIMEOUT_ZIP_MS) },
    );
    if (!resp.ok) {
      throw new Error(resp.status === 403
        ? 'O criador é do admin global — confirme o login no app.'
        : `Não consegui baixar o escritório (HTTP ${resp.status}).`);
    }
    const zipBuf = Buffer.from(await resp.arrayBuffer());

    const workDir = path.join(this._root, 'criador', slug);
    const officeDir = path.join(workDir, 'escritorio');
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(officeDir, { recursive: true });

    const zipTmp = path.join(os.tmpdir(), `offiz-criador-${slug}-${Date.now()}.zip`);
    fs.writeFileSync(zipTmp, zipBuf);
    try { extrairZip(zipTmp, officeDir); } finally {
      try { fs.rmSync(zipTmp, { force: true }); } catch { /* tmp */ }
    }
    if (!fs.existsSync(path.join(officeDir, 'office.json'))) {
      fs.rmSync(workDir, { recursive: true, force: true });
      throw new Error('O pacote baixado não tem office.json — escritório corrompido?');
    }

    // A persona do CRIADOR na raiz (o CLAUDE.md do escritório fica em
    // escritorio/CLAUDE.md, como arquivo a editar — não como persona).
    fs.writeFileSync(
      path.join(workDir, 'CLAUDE.md'),
      fs.readFileSync(path.join(__dirname, 'CRIADOR-CLAUDE.md'), 'utf-8'),
      'utf-8',
    );

    this._slug = slug;
    this._workDir = workDir;
    this._officeDir = officeDir;
    this._sessionId = crypto.randomUUID();
    this._turnos = 0;
    this._snapAbertura = _snapshot(officeDir);
    this._emitirManifesto();
    return this.estado();
  }

  /** Um turno da conversa. Resolve quando o turno TERMINA (os eventos vão
   *  chegando pelo 'evento' enquanto isso). */
  async enviar({ texto, model, effort }) {
    if (!this.aberta) throw new Error('Nenhum escritório aberto.');
    if (this._ocupado) throw new Error('Aguarde o turno atual terminar.');
    texto = String(texto || '').trim();
    if (!texto) throw new Error('Mensagem vazia.');

    this._ocupado = true;
    this._emitir('status', { ocupado: true });
    const parser = new StreamJsonParser();
    const stderrTail = [];
    let erro = null;

    try {
      const base = resolveClaudeCmd(this._claudeBin);
      const args = base.slice(1).concat(buildArgsTurno({
        sessionId: this._sessionId,
        primeiroTurno: this._turnos === 0,
        model,
        effort,
      }));
      const { spawn } = require('child_process');
      const proc = spawn(base[0], args, {
        cwd: this._workDir,
        env: buildClaudeEnv(null, 'cli'),   // sessão do consultor: login DELE
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this._proc = proc;
      proc.stdin.on('error', () => { /* EPIPE tratado no close */ });
      proc.stdin.write(texto.endsWith('\n') ? texto : texto + '\n', 'utf-8');
      proc.stdin.end();

      proc.stderr.setEncoding('utf-8');
      proc.stderr.on('data', (chunk) => {
        for (const l of String(chunk).split(/\r?\n/)) {
          if (l.trim()) { stderrTail.push(l.trim()); if (stderrTail.length > 20) stderrTail.shift(); }
        }
      });
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (chunk) => {
        for (const ev of parser.feed(chunk)) this._emitir(ev.tipo, ev.payload);
      });

      const deadline = Date.now() + TIMEOUT_TURNO_MIN * 60 * 1000;
      const watchdog = setInterval(() => {
        if (Date.now() > deadline) { clearInterval(watchdog); killProcessTree(proc); }
      }, 1000);

      const rc = await new Promise((resolve) => {
        proc.on('close', (code) => resolve(code));
        proc.on('error', (e) => { erro = `Falha ao iniciar o Claude: ${e.message}`; resolve(-1); });
      });
      clearInterval(watchdog);
      for (const ev of parser.close()) this._emitir(ev.tipo, ev.payload);

      if (parser.resultInfo && parser.resultInfo.is_error) {
        erro = parser.resultInfo.erro || 'O Claude terminou com erro.';
      } else if (rc !== 0 && !erro) {
        const detalhe = stderrTail.slice(-4).join(' | ').slice(0, 300);
        erro = `O Claude terminou com código ${rc}.${detalhe ? ` Detalhe: ${detalhe}` : ''}`;
      }
      if (!erro) this._turnos += 1;
    } catch (e) {
      erro = e.message;
    } finally {
      this._proc = null;
      this._ocupado = false;
      if (erro) this._emitir('erro', { mensagem: erro });
      // O manifesto e a lista de alterados SEMPRE ao fim do turno — é o que
      // faz o lado direito da tela acompanhar a conversa.
      this._emitirManifesto();
      this._emitir('status', { ocupado: false });
    }
    return { ok: !erro, error: erro || undefined, turnos: this._turnos };
  }

  /** Interrompe o turno atual (o processo morre; a sessão continua aberta —
   *  o próximo enviar() usa --resume normalmente). */
  cancelar() {
    if (this._proc) killProcessTree(this._proc);
    return { ok: true };
  }

  _lerManifesto() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this._officeDir, 'office.json'), 'utf-8'));
    } catch {
      return null; // sessão pode ter quebrado o JSON no meio de uma edição
    }
  }

  /** Arquivos que a sessão criou/alterou/removeu desde a abertura. */
  _alterados() {
    const agora = _snapshot(this._officeDir);
    const out = [];
    for (const [rel, st] of agora) {
      const antes = this._snapAbertura.get(rel);
      if (!antes) out.push({ caminho: rel, acao: 'novo' });
      else if (antes.tamanho !== st.tamanho || antes.mtimeMs !== st.mtimeMs) {
        out.push({ caminho: rel, acao: 'alterado' });
      }
    }
    for (const rel of this._snapAbertura.keys()) {
      if (!agora.has(rel)) out.push({ caminho: rel, acao: 'removido' });
    }
    return out.sort((a, b) => a.caminho.localeCompare(b.caminho));
  }

  _emitirManifesto() {
    if (!this.aberta) return;
    this._emitir('manifesto', { manifesto: this._lerManifesto(), alterados: this._alterados() });
  }

  estado() {
    return {
      aberta: this.aberta,
      slug: this._slug,
      ocupado: this._ocupado,
      turnos: this._turnos,
      manifesto: this.aberta ? this._lerManifesto() : null,
      alterados: this.aberta ? this._alterados() : [],
    };
  }

  /** Publica escritorio/ no catálogo (o POST revalida tudo do lado de lá). */
  async publicar({ backendUrl, jwt }) {
    if (!this.aberta) throw new Error('Nenhum escritório aberto.');
    if (this._ocupado) throw new Error('Espere o turno terminar antes de publicar.');
    const manifesto = this._lerManifesto();
    if (!manifesto) throw new Error('O office.json está ilegível — peça à sessão para corrigir antes de publicar.');
    if (String(manifesto.slug || this._slug) !== this._slug) {
      throw new Error(`O office.json diz slug '${manifesto.slug}' — o slug não pode mudar numa edição.`);
    }

    const zipTmp = path.join(os.tmpdir(), `offiz-publicar-${this._slug}-${Date.now()}.zip`);
    ziparPasta(this._officeDir, zipTmp);
    try {
      const conteudo = fs.readFileSync(zipTmp);
      const boundary = '----offiz' + crypto.randomBytes(12).toString('hex');
      const head =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="arquivo"; filename="office-${this._slug}.zip"\r\n` +
        'Content-Type: application/zip\r\n\r\n';
      const body = Buffer.concat([
        Buffer.from(head, 'utf-8'), conteudo, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'),
      ]);
      const resp = await fetch(`${_base(backendUrl)}/api/v1/admin/offices/${this._slug}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_PUBLICAR_MS),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const detail = data && data.detail ? String(data.detail) : `HTTP ${resp.status}`;
        throw new Error(`O servidor recusou a publicação: ${detail}`);
      }
      // Publicado = o catálogo é a nova base; o diff da sessão zera.
      this._snapAbertura = _snapshot(this._officeDir);
      this._emitirManifesto();
      return { ok: true, alterados: [], resposta: data };
    } finally {
      try { fs.rmSync(zipTmp, { force: true }); } catch { /* tmp */ }
    }
  }

  /** Descarta a pasta de trabalho (nada foi publicado = nada aconteceu). */
  fechar() {
    if (this._proc) killProcessTree(this._proc);
    if (this._workDir) {
      try { fs.rmSync(this._workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    this._slug = null;
    this._workDir = null;
    this._officeDir = null;
    this._sessionId = null;
    this._turnos = 0;
    this._ocupado = false;
    this._snapAbertura = new Map();
    return { ok: true };
  }
}

module.exports = { CriadorSessao, buildArgsTurno, ziparPasta };
