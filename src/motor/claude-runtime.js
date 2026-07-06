// Spawn do Claude Code CLI headless + parse do stream NDJSON (stream-json).
//
// Porta em Node do webapp/worker/claude_proc.py (que por sua vez veio do
// desktop C:/Offiz/Offiz/ipc/claude-runtime.js). Mantém o MESMO contrato de
// eventos do worker cloud: agent_text / tool_use / subagente / resultado.
//
// Modos de credencial (motor_modo do claim):
// - "api": injeta a ANTHROPIC_API_KEY da organização (BYOK) e remove TODA
//   credencial da máquina — o custo é sempre da org.
// - "cli": NÃO injeta chave nenhuma e preserva o login local do cliente
//   (claude login / CLAUDE_CODE_OAUTH_TOKEN) — roda na assinatura DELE.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = 'high';

// Campos do input de tool_use que melhor resumem a ação (mesma ordem do
// worker cloud — o feed do site mostra este resumo).
const RESUMO_KEYS = [
  'file_path', 'path', 'notebook_path', 'command', 'pattern',
  'url', 'query', 'description', 'prompt',
];
const RESUMO_MAX = 200;

function resolveEffort(effort) {
  const key = String(effort || '').trim().toLowerCase();
  return VALID_EFFORTS.has(key) ? key : DEFAULT_EFFORT;
}

function buildClaudeArgs(model, effort, sessionId) {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--effort', resolveEffort(effort),
    '--session-id', sessionId,
    '--dangerously-skip-permissions',
  ];
}

function buildClaudeEnv(anthropicApiKey, motorModo) {
  const env = { ...process.env };
  // Vars que, sobrando no ambiente, têm precedência sobre a chave injetada e
  // cobrariam a conta errada (ou dariam 401).
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  if (motorModo === 'cli') {
    // Modo CLI: preserva CLAUDE_CODE_OAUTH_TOKEN (se o cliente usou
    // `claude setup-token`) e deixa o CLI cair no login local. Nunca injeta.
  } else {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (anthropicApiKey) env.ANTHROPIC_API_KEY = anthropicApiKey;
  }
  env.PYTHONIOENCODING = 'utf-8';
  // O Claude CLI recusa --dangerously-skip-permissions rodando como root;
  // IS_SANDBOX=1 é a válvula oficial para ambiente confinado (raro no
  // desktop, mas cobre quem abrir o app como root/sudo no Mac/Linux).
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    env.IS_SANDBOX = '1';
  }
  // Mac lançado pelo Finder: PATH mínimo do launchd (sem homebrew nem
  // ~/.local/bin). Mesmo com o claude resolvido por caminho absoluto, o shim
  // npm tem shebang `#!/usr/bin/env node` — o filho ainda precisa achar o node.
  if (process.platform === 'darwin') {
    const home = process.env.HOME || '';
    const extra = [
      path.join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(home, '.npm-global', 'bin'),
    ];
    env.PATH = extra.concat(env.PATH || '').join(':');
  }
  return env;
}

// Candidatos comuns de instalação do claude por SO (fallback quando não está
// no PATH — apps GUI empacotados NÃO herdam o PATH do shell: no Windows o
// `where` pode vir vazio; no Mac o Finder dá o PATH pobre do launchd).
function claudeCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      // .exe primeiro: roda sem shell e preserva UTF-8 (o wrapper .cmd via
      // cmd.exe pode corromper acentos).
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(appData, 'npm', 'claude.exe'),
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(home, '.local', 'bin', 'claude.cmd'),
      path.join(appData, 'npm', 'claude.cmd'),
    ];
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',   // Apple Silicon
    '/usr/local/bin/claude',      // Intel / npm -g
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
    path.join(home, 'bin', 'claude'),
  ];
}

function _existe(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** Procura o claude no prefixo GLOBAL do npm (`npm prefix -g`) — cobre
 *  instalações npm i -g com prefixo customizado que não estão nem no PATH
 *  do app GUI nem nos caminhos fixos. No Windows os shims ficam direto no
 *  prefixo (claude.exe/claude.cmd); no unix em <prefixo>/bin/claude. */
function _claudeDoNpmGlobal() {
  const r = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'npm', 'prefix', '-g'], { encoding: 'utf-8', windowsHide: true, timeout: 8000 })
    : spawnSync('npm', ['prefix', '-g'], { encoding: 'utf-8', timeout: 8000 });
  if (r.error || r.status !== 0 || !r.stdout) return '';
  const prefixo = r.stdout.trim().split(/\r?\n/)[0].trim();
  if (!prefixo) return '';
  const candidatos = process.platform === 'win32'
    ? [path.join(prefixo, 'claude.exe'), path.join(prefixo, 'claude.cmd')]
    : [path.join(prefixo, 'bin', 'claude')];
  return candidatos.find(_existe) || '';
}

/**
 * Resolve o comando-base do claude → array argv (ex.: ['cmd','/c','...claude.cmd']).
 *
 * Cuidados herdados do desktop battle-tested:
 * - where/which primeiro, mas REORDENANDO .exe antes de .cmd (o npm global
 *   instala os dois; o .exe nativo roda com shell:false e UTF-8 intacto);
 * - TODO caminho é filtrado por fs.existsSync — um .exe fantasma no PATH
 *   estouraria ENOENT ganhando de um .cmd real;
 * - wrappers .cmd/.bat não executam direto pelo CreateProcess → 'cmd /c'.
 */
function resolveClaudeCmd(claudeBin) {
  let resolved = String(claudeBin || '').trim();
  if (resolved && !_existe(resolved)) resolved = '';

  if (!resolved) {
    // 1) PATH (where/which), com .exe primeiro e filtro de existência
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(finder, ['claude'], { encoding: 'utf-8', windowsHide: true });
    if (r.status === 0 && r.stdout) {
      let doPath = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (process.platform === 'win32') {
        // Só claude.exe/claude.cmd(.bat): o `where` também lista o shim SEM
        // extensão (script bash do npm) que o CreateProcess NÃO executa.
        doPath = doPath.filter((p) => /\.(exe|cmd|bat)$/i.test(p));
      }
      const ordenados = doPath
        .filter((p) => /\.exe$/i.test(p))
        .concat(doPath.filter((p) => !/\.exe$/i.test(p)));
      resolved = ordenados.find(_existe) || '';
    }
    // 2) caminhos fixos comuns (app GUI sem o PATH do shell) — inclui o
    //    destino do instalador nativo (~/.local/bin) e o npm global padrão
    if (!resolved) resolved = claudeCandidates().find(_existe) || '';
    // 3) prefixo global do npm (npm i -g com prefixo customizado, fora dos
    //    caminhos fixos) — último recurso, só roda se nada acima achou
    if (!resolved) resolved = _claudeDoNpmGlobal();
  }

  if (!resolved) {
    throw new Error(
      'Claude Code CLI não encontrado. Use o botão "Instalar Claude CLI" no painel ' +
      'do motor, instale manualmente (npm install -g @anthropic-ai/claude-code) ' +
      'ou aponte o binário nas configurações avançadas.'
    );
  }
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(resolved)) {
    return ['cmd', '/c', resolved];
  }
  return [resolved];
}

/**
 * Spawna o Claude headless no workspace e envia o prompt via STDIN em UTF-8
 * (evita mojibake de acentos no Windows e limite de tamanho de linha de comando).
 */
function spawnClaude({ workspaceDir, prompt, model, effort, sessionId, anthropicApiKey, motorModo, claudeBin }) {
  const base = resolveClaudeCmd(claudeBin);
  const args = base.slice(1).concat(buildClaudeArgs(model, effort, sessionId));

  const proc = spawn(base[0], args, {
    cwd: workspaceDir,
    env: buildClaudeEnv(anthropicApiKey, motorModo),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Grupo próprio no unix: killProcessTree mata o claude E os filhos dele.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  proc.stdin.on('error', () => { /* EPIPE se o claude morrer cedo — tratado no close */ });
  proc.stdin.write(prompt.endsWith('\n') ? prompt : prompt + '\n', 'utf-8');
  proc.stdin.end();
  return proc;
}

/** Mata o processo do Claude e toda a árvore de filhos (cancelamento/timeout).
 *
 *  ASSÍNCRONO de propósito: roda no main process do Electron — um taskkill
 *  síncrono de até 15s congelaria a UI inteira. O chamador não precisa
 *  esperar: o 'close' do processo sinaliza o fim. Idempotente (_offizKilled). */
function killProcessTree(proc) {
  if (proc.exitCode !== null || proc.signalCode || proc._offizKilled) return;
  proc._offizKilled = true;
  try {
    if (process.platform === 'win32') {
      // taskkill /T mata a árvore inteira (com 'cmd /c' o pid é o do cmd —
      // o /T alcança o claude filho).
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
        windowsHide: true, stdio: 'ignore',
      }).on('error', () => { try { proc.kill('SIGKILL'); } catch { /* já morreu */ } });
    } else {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    }
  } catch {
    try { proc.kill('SIGKILL'); } catch { /* já morreu */ }
  }
}

function toolResumo(inputObj) {
  if (!inputObj || typeof inputObj !== 'object' || Array.isArray(inputObj)) return '';
  for (const key of RESUMO_KEYS) {
    const v = inputObj[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, RESUMO_MAX);
  }
  for (const v of Object.values(inputObj)) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, RESUMO_MAX);
  }
  return '';
}

/**
 * Parser incremental do stream-json do Claude Code → eventos do contrato.
 * Uso: parser.feed(chunk) conforme o stdout chega; parser.close() no final
 * (flush da última linha sem '\n'). Cada evento: {tipo, payload}.
 *
 * Linhas não-JSON são ignoradas em silêncio (o CLI às vezes intercala logs).
 * Deduplicação parcial/completo: com --include-partial-messages o texto vem
 * duas vezes (deltas + bloco completo) — se deltas foram emitidos, o bloco
 * completo é pulado.
 */
class StreamJsonParser {
  constructor(usdBrlRate) {
    const fromEnv = parseFloat(process.env.USD_BRL_RATE || '');
    this._rate = Number.isFinite(usdBrlRate) ? usdBrlRate
      : Number.isFinite(fromEnv) ? fromEnv : 5.5;
    this._buf = '';
    this._streamedText = false;   // deltas já emitidos p/ msg corrente
    this._taskIds = new Map();    // tool_use_id do Task → nome do subagente
    this.resultInfo = null;
  }

  feed(data) {
    const events = [];
    this._buf += data;
    let lf;
    while ((lf = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, lf);
      this._buf = this._buf.slice(lf + 1);
      events.push(...this._consumeLine(line));
    }
    return events;
  }

  close() {
    const line = this._buf;
    this._buf = '';
    return this._consumeLine(line);
  }

  _consumeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let obj;
    try { obj = JSON.parse(trimmed); } catch { return []; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    try { return this._parseObj(obj); } catch { return []; }
  }

  _parseObj(ev) {
    const t = ev.type;

    if (t === 'stream_event') {
      const inner = ev.event || {};
      if (inner && inner.type === 'content_block_delta') {
        const delta = inner.delta || {};
        if (delta && delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          this._streamedText = true;
          return [{ tipo: 'agent_text', payload: { texto: delta.text } }];
        }
      }
      return [];
    }
    if (t === 'assistant') return this._parseAssistant(ev);
    if (t === 'user') return this._parseUser(ev);
    if (t === 'result') return this._parseResult(ev);
    return []; // system/init, rate_limit_event etc.
  }

  _parseAssistant(ev) {
    const msg = ev.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const out = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text && !this._streamedText) {
          out.push({ tipo: 'agent_text', payload: { texto: block.text } });
        }
      } else if (block.type === 'tool_use') {
        out.push(this._parseToolUse(block));
      }
    }
    this._streamedText = false; // próxima mensagem recomeça a detecção de deltas
    return out;
  }

  _parseToolUse(block) {
    const name = String(block.name || 'ferramenta');
    const inputObj = block.input || {};
    if (name === 'Task') {
      let nome = '';
      if (inputObj && typeof inputObj === 'object') {
        nome = String(inputObj.subagent_type || inputObj.description || '').trim();
      }
      nome = nome || 'subagente';
      if (typeof block.id === 'string' && block.id) this._taskIds.set(block.id, nome);
      return { tipo: 'subagente', payload: { nome, acao: 'start' } };
    }
    return { tipo: 'tool_use', payload: { ferramenta: name, resumo: toolResumo(inputObj) } };
  }

  _parseUser(ev) {
    // tool_result de um Task = o subagente terminou (subagente/stop).
    const msg = ev.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const out = [];
    for (const block of content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
      const nome = this._taskIds.get(block.tool_use_id);
      if (nome) {
        this._taskIds.delete(block.tool_use_id);
        out.push({ tipo: 'subagente', payload: { nome, acao: 'stop' } });
      }
    }
    return out;
  }

  _parseResult(ev) {
    const usage = (ev.usage && typeof ev.usage === 'object') ? ev.usage : {};
    const tok = (k) => {
      const n = parseInt(usage[k], 10);
      return Number.isFinite(n) ? n : 0;
    };
    const tokensEntrada = tok('input_tokens') + tok('cache_creation_input_tokens') + tok('cache_read_input_tokens');
    const tokensSaida = tok('output_tokens');
    let custoBrl = 0;
    const usd = parseFloat(ev.total_cost_usd);
    if (Number.isFinite(usd)) custoBrl = Math.round(usd * this._rate * 1e6) / 1e6;
    const duracaoMs = Number.isFinite(parseInt(ev.duration_ms, 10)) ? parseInt(ev.duration_ms, 10) : 0;

    const isError = Boolean(ev.is_error);
    const erro = isError ? (String(ev.result || '').trim() || 'O Claude terminou com erro.') : null;

    this.resultInfo = {
      tokens_entrada: tokensEntrada,
      tokens_saida: tokensSaida,
      custo_brl: custoBrl,
      duracao_ms: duracaoMs,
      is_error: isError,
      erro,
    };
    return [{
      tipo: 'resultado',
      payload: {
        tokens_entrada: tokensEntrada,
        tokens_saida: tokensSaida,
        custo_brl: custoBrl,
        duracao_ms: duracaoMs,
      },
    }];
  }
}

module.exports = {
  buildClaudeArgs,
  buildClaudeEnv,
  resolveClaudeCmd,
  claudeCandidates,
  spawnClaude,
  killProcessTree,
  StreamJsonParser,
};
