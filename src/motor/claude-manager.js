// Gerenciador do Claude Code CLI na máquina do cliente.
//
// Porta dos mecanismos battle-tested do desktop antigo (C:/Offiz/Offiz):
// 3 camadas de verdade sobre o estado do Claude —
//   1. INSTALADO?  `claude --version` (spawnSync local, 4s, sem cota)
//   2. LOGADO?     `claude auth status --json` (read-only, 6s, sem cota) +
//                  expiresAt do ~/.claude/.credentials.json (token vencido?)
//                  — porque o `auth status` MENTE (diz loggedIn:true com
//                  token morto).
//   3. CONECTAR    `claude auth login --claudeai` com stdout em PIPE: captura
//                  a URL do OAuth no buffer, abre o navegador padrão e o
//                  callback web conclui SOZINHO (o processo troca code→token
//                  e sai 0) — o cliente não cola código nem vê terminal.
//                  Fallback: terminal VISÍVEL (wt/cmd no Windows; script
//                  .command + `open -a Terminal` no Mac — app GUI não tem TTY).

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveClaudeCmd, killProcessTree } = require('./claude-runtime');

// PATH aumentado p/ spawns no *nix: mesmo com o claude resolvido por caminho
// absoluto, o shim do npm tem shebang `#!/usr/bin/env node` — o filho ainda
// precisa achar o node. (No Windows o resolve já dá o caminho cheio.)
function _spawnEnvLimpo(extraSanitize) {
  const env = { ...process.env };
  if (extraSanitize) {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      delete env[k];
    }
  }
  if (process.platform !== 'win32') {
    const home = os.homedir() || '';
    const extras = ['/opt/homebrew/bin', '/usr/local/bin',
      path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin')];
    const cur = (env.PATH || '').split(path.delimiter).filter(Boolean);
    env.PATH = extras.filter((d) => !cur.includes(d)).concat(cur).join(path.delimiter);
  }
  return env;
}

function _resolve(claudeBin) {
  try {
    return resolveClaudeCmd(claudeBin); // argv base, ex.: ['cmd','/c','...claude.cmd']
  } catch {
    return null;
  }
}

function _runClaude(base, args, timeoutMs) {
  return spawnSync(base[0], base.slice(1).concat(args), {
    timeout: timeoutMs,
    windowsHide: true,
    encoding: 'utf-8',
    env: _spawnEnvLimpo(false),
  });
}

/** expiresAt (epoch ms) do OAuth da assinatura — ~/.claude/.credentials.json. */
function _tokenExpiresAt() {
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const o = (j && j.claudeAiOauth) || j;
    return (o && typeof o.expiresAt === 'number') ? o.expiresAt : null;
  } catch {
    return null;
  }
}

/** Classificador: a mensagem indica DESLOGADO (e não binário ausente)? */
function isLoginError(texto) {
  const t = String(texto || '').toLowerCase();
  if (!t) return false;
  const autenticacao = /login|logged|auth|token|oauth|credential|unauthorized|401/.test(t);
  const ausencia = /not found|enoent|não encontrado|nao encontrado|reconhecido/.test(t);
  return autenticacao && !ausencia;
}

/**
 * Estado consolidado do Claude na máquina. NUNCA lança — sempre devolve objeto:
 * { installed, versao, loggedIn (true|false|null), tokenExpired, subscriptionType, authMethod, bin }
 */
function statusClaude(claudeBin) {
  const base = _resolve(claudeBin);
  if (!base) return { installed: false, loggedIn: null, bin: null };
  const bin = base[base.length - 1];

  // 1) instalado? (--version responde)
  const v = _runClaude(base, ['--version'], 4000);
  if (v.error || v.status !== 0) return { installed: false, loggedIn: null, bin };
  const versao = String(v.stdout || '').trim().split(/\r?\n/)[0] || '';

  // 2) logado? (auth status --json; parse defensivo: 1º bloco {...})
  const s = _runClaude(base, ['auth', 'status', '--json'], 6000);
  let loggedIn = null, subscriptionType = null, authMethod = null;
  const saida = `${s.stdout || ''}\n${s.stderr || ''}`;
  const m = saida.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (typeof j.loggedIn === 'boolean') loggedIn = j.loggedIn;
      subscriptionType = j.subscriptionType || null;
      authMethod = j.authMethod || null;
    } catch { /* JSON sujo — cai no fallback textual */ }
  }
  if (loggedIn === null && isLoginError(saida)) loggedIn = false;

  const exp = _tokenExpiresAt();
  const tokenExpired = (typeof exp === 'number') ? exp < Date.now() : null;

  return { installed: true, versao, loggedIn, tokenExpired, subscriptionType, authMethod, bin };
}

// ─── Instalação com 1 clique (instalador nativo da Anthropic) ──────────────
//
// Windows: `irm https://claude.ai/install.ps1 | iex` (PowerShell, sem admin —
// instala em %USERPROFILE%\.local\bin\claude.exe).
// mac/linux: `curl -fsSL https://claude.ai/install.sh | bash` (~/.local/bin).
// A saída é streamada linha a linha para a UI; ao final o binário é
// REDETECTADO de verdade (exit 0 do instalador não basta) — o caminho achado
// volta ao chamador para ser fixado em cfg.claudeBin (apps GUI não enxergam
// o PATH novo que o instalador escreveu no perfil do shell).

let _installChild = null;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000; // generoso: download em rede lenta

/**
 * Instala o Claude Code CLI com o instalador oficial. onLine(linha) recebe a
 * saída ao vivo. NUNCA lança — devolve:
 * { ok, versao?, bin?, jaInstalado? } ou { ok:false, error, log? (últimas linhas) }.
 */
function instalarClaude(claudeBin, onLine) {
  const emit = (linha) => { try { if (onLine) onLine(linha); } catch { /* UI fechou */ } };

  // Idempotente: já instalado → não reinstala, só devolve o que achou.
  const st = statusClaude(claudeBin);
  if (st.installed) {
    return Promise.resolve({ ok: true, jaInstalado: true, versao: st.versao, bin: st.bin });
  }
  if (_installChild) {
    return Promise.resolve({ ok: false, error: 'Já existe uma instalação em andamento — aguarde ela terminar.' });
  }

  return new Promise((resolve) => {
    const tail = []; // últimas linhas p/ diagnóstico em caso de erro
    const push = (chunk) => {
      for (const l of String(chunk).split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        tail.push(t);
        if (tail.length > 40) tail.shift();
        emit(t);
      }
    };

    let child;
    try {
      child = process.platform === 'win32'
        ? spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            'irm https://claude.ai/install.ps1 | iex'],
          { windowsHide: true, env: _spawnEnvLimpo(false) })
        : spawn('bash', ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'],
          // Grupo próprio: o timeout mata a ÁRVORE (curl/instalador filhos).
          { env: _spawnEnvLimpo(false), detached: true });
    } catch (e) {
      return resolve({ ok: false, error: `Não foi possível iniciar o instalador: ${e.message}` });
    }
    _installChild = child;

    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      _installChild = null;
      resolve(r);
    };

    const timer = setTimeout(() => {
      emit('[Offiz] A instalação passou de 5 minutos — cancelando.');
      // Árvore inteira: matar só o powershell/bash deixaria o download ou o
      // instalador filho órfão (um retry colidiria com ele).
      try { killProcessTree(child); } catch { /* já morreu */ }
      finish({ ok: false, error: 'A instalação demorou demais (5 min) e foi cancelada — tente de novo ou instale manualmente.', log: tail.slice(-8) });
    }, INSTALL_TIMEOUT_MS);

    if (child.stdout) { child.stdout.setEncoding('utf-8'); child.stdout.on('data', push); }
    if (child.stderr) { child.stderr.setEncoding('utf-8'); child.stderr.on('data', push); }
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: `O instalador não rodou: ${e.message}`, log: tail.slice(-8) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Redetecção SEM override ('' = autodetectar): o instalador nativo cai
      // em ~/.local/bin, que já está nos candidatos do resolve.
      const depois = statusClaude('');
      if (depois.installed) {
        finish({ ok: true, versao: depois.versao, bin: depois.bin });
      } else {
        finish({
          ok: false,
          error: code === 0
            ? 'O instalador terminou, mas o claude não foi encontrado — reinicie o app ou instale manualmente.'
            : `O instalador terminou com código ${code}.`,
          log: tail.slice(-8),
        });
      }
    });
  });
}

// ─── Login guiado (sem terminal): captura a URL OAuth e abre o navegador ───

let _loginChild = null;
let _loginResult = null;
let _loginWaiters = [];

function _killLoginChild() {
  try { if (_loginChild) _loginChild.kill(); } catch { /* já morreu */ }
  _loginChild = null;
}

function _finishLogin(result) {
  if (_loginResult) return; // 1ª causa vence (idempotente)
  _loginResult = result;
  _loginChild = null;
  const ws = _loginWaiters; _loginWaiters = [];
  for (const w of ws) { try { w(result); } catch { /* waiter morto */ } }
}

/**
 * Inicia `claude auth login --claudeai`, captura a URL do OAuth e chama
 * `openExternal(url)`. Resolve { ok, url } assim que o navegador abre; o
 * processo segue vivo — aguarde a conclusão com loginWait().
 */
function loginStart(claudeBin, openExternal) {
  _killLoginChild();
  _loginResult = null; _loginWaiters = [];

  const base = _resolve(claudeBin);
  if (!base) {
    return Promise.resolve({ ok: false, missing: true, error: 'O Claude ainda não está instalado neste computador.' });
  }

  return new Promise((resolve) => {
    let buf = '', urlSent = false;
    const sendUrl = (v) => { if (!urlSent) { urlSent = true; resolve(v); } };

    let child;
    try {
      child = spawn(base[0], base.slice(1).concat(['auth', 'login', '--claudeai']), {
        env: _spawnEnvLimpo(true), // sem ANTHROPIC_* — força o OAuth da assinatura
        windowsHide: true,
      });
    } catch (e) {
      return sendUrl({ ok: false, error: e.message });
    }
    _loginChild = child;

    const scan = (chunk) => {
      buf += String(chunk);
      const m = buf.match(/https:\/\/\S*oauth\/authorize\S*/i);
      if (m && !urlSent) {
        const url = m[0].replace(/[)\].,'"]+$/, '');
        try { openExternal(url); } catch { /* navegador não abriu — a URL vai pra UI */ }
        sendUrl({ ok: true, url });
      }
    };
    if (child.stdout) child.stdout.on('data', scan);
    if (child.stderr) child.stderr.on('data', scan);
    child.on('error', (e) => {
      sendUrl({ ok: false, error: e.message });
      _finishLogin({ ok: false, error: e.message });
    });
    child.on('exit', (code) => {
      // Exit 0 NÃO basta: re-verifica o estado real da credencial.
      const st = statusClaude(claudeBin);
      const authOk = code === 0 && st.loggedIn !== false && st.tokenExpired !== true && !isLoginError(buf);
      _finishLogin(authOk ? { ok: true }
        : isLoginError(buf)
          ? { ok: false, reason: 'auth', error: 'O login não foi concluído — autorize no navegador e tente de novo.' }
          : { ok: false, error: buf.trim().slice(-220) || `O login encerrou (código ${code}).` });
      sendUrl({ ok: false, error: 'O login encerrou antes de abrir o navegador.' });
    });
    setTimeout(() => sendUrl({ ok: false, error: 'Demorou demais para abrir o login — tente de novo.' }), 20000);
  });
}

/** Aguarda a conclusão do login iniciado por loginStart (até 4 min). */
function loginWait() {
  if (_loginResult) return Promise.resolve(_loginResult);
  if (!_loginChild) return Promise.resolve({ ok: false, error: 'Nenhum login em andamento — clique em Conectar de novo.' });
  return new Promise((resolve) => {
    _loginWaiters.push(resolve);
    setTimeout(() => resolve({ ok: false, reason: 'timeout', error: 'Tempo esgotado esperando o login.' }), 240000);
  });
}

function loginCancel() {
  _killLoginChild();
  _finishLogin({ ok: false, reason: 'cancel' });
  return { ok: true };
}

// ─── Terminal VISÍVEL (fallback e setup-token) ─────────────────────────────

/** macOS/Linux: app GUI não tem TTY — escreve um script .command (0755) e pede
 *  um terminal de verdade ao SO (`open -a Terminal` no Mac). */
function _openNixTerminal(bin, args) {
  const q = (a) => "'" + String(a).replace(/'/g, "'\\''") + "'";
  const linhas = [
    '#!/bin/bash',
    'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    q(bin) + ' ' + (args || []).map(q).join(' '),
    'echo; echo "[Offiz] Pode fechar esta janela quando terminar."',
  ];
  const tmp = path.join(os.tmpdir(), `offiz-terminal-${Date.now()}.command`);
  fs.writeFileSync(tmp, linhas.join('\n') + '\n', { mode: 0o755 });
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', tmp], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const termos = [
    ['x-terminal-emulator', ['-e', tmp]],
    ['gnome-terminal', ['--', tmp]],
    ['konsole', ['-e', tmp]],
    ['xterm', ['-e', tmp]],
  ];
  for (const [t, targs] of termos) {
    const w = spawnSync('which', [t], { encoding: 'utf-8' });
    if (!w.error && w.status === 0) {
      spawn(t, targs, { detached: true, stdio: 'ignore' }).unref();
      return;
    }
  }
  spawn(bin, args || [], { detached: true, stdio: 'inherit' }).unref();
}

/** Windows: Windows Terminal (wt) preferido; fallback cmd /k (janela fica
 *  aberta para o cliente ver o resultado). Lançado via powershell Start-Process. */
function _openWinTerminal(bin, args, titulo) {
  const quote = (a) => "'" + String(a).replace(/'/g, "''") + "'";
  const argListWt = ['new-tab', '--title', titulo, bin].concat(args)
    .map(quote).join(',');
  const cmdInner = '"' + bin + '" ' + args.join(' ');
  const cmd =
    `$wt = Get-Command wt -ErrorAction SilentlyContinue;` +
    `if ($wt) { Start-Process wt -ArgumentList @(${argListWt}) }` +
    ` else { Start-Process cmd.exe -ArgumentList @('/k', ${quote(cmdInner)}) }`;
  spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { detached: true, stdio: 'ignore' }).unref();
}

/** Abre `claude <args>` num terminal visível (fluxos interativos). */
function abrirTerminalClaude(claudeBin, args, titulo) {
  const base = _resolve(claudeBin);
  if (!base) return { ok: false, missing: true, error: 'O Claude ainda não está instalado neste computador.' };
  const bin = base[base.length - 1];
  try {
    if (process.platform === 'win32') _openWinTerminal(bin, args, titulo || 'Claude');
    else _openNixTerminal(bin, args);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** `claude auth login` em terminal visível (fallback do login guiado). */
function reloginTerminal(claudeBin) {
  return abrirTerminalClaude(claudeBin, ['auth', 'login'], 'Reconectar conta Claude');
}

/** `claude setup-token` em terminal visível (token durável — opção avançada). */
function setupTokenTerminal(claudeBin) {
  return abrirTerminalClaude(claudeBin, ['setup-token'], 'Configurar token do Claude');
}

module.exports = {
  statusClaude,
  instalarClaude,
  isLoginError,
  loginStart,
  loginWait,
  loginCancel,
  reloginTerminal,
  setupTokenTerminal,
};
