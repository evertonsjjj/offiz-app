// Gestão do CODEX CLI (OpenAI) na máquina do cliente — irmão do
// claude-manager, três responsabilidades e nada além:
//   1. INSTALADO?  `codex --version` (spawnSync, 4s)
//   2. INSTALAR    npm i -g @openai/codex@0.150.0 (a versão em que o contrato
//                  do Offiz foi validado — flag nova/removida no Codex já
//                  matou spawn uma vez; o pin é o seguro)
//   3. TERMINAL    abre `codex login` num terminal do SO (opcional: os jobs
//                  da org rodam com a CHAVE dela, que chega pelo claim; o
//                  login local só serve para o dono testar o CLI à mão).

'use strict';

const { spawn, spawnSync } = require('child_process');

const CODEX_PIN = '0.150.0';
let _installChild = null;

function _resolve(codexBin) {
  const binario = codexBin || process.env.CODEX_BIN || 'codex';
  if (process.platform === 'win32') {
    const r = spawnSync('where.exe', [binario], { encoding: 'utf-8', windowsHide: true });
    const achado = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    const alvo = achado || binario;
    if (/\.(cmd|bat)$/i.test(alvo)) return [process.env.COMSPEC || 'cmd.exe', '/c', alvo];
    return [alvo];
  }
  return [binario];
}

function statusCodex(codexBin) {
  const base = _resolve(codexBin);
  let r;
  try {
    r = spawnSync(base[0], base.slice(1).concat(['--version']), {
      encoding: 'utf-8', timeout: 4000, windowsHide: true,
    });
  } catch (e) {
    return { installed: false, error: e.message };
  }
  if (r.error || r.status !== 0) {
    return { installed: false };
  }
  const versao = String(r.stdout || r.stderr || '').trim().split(/\r?\n/)[0].slice(0, 60);
  return { installed: true, versao, bin: base.join(' ') };
}

function instalarCodex(codexBin, onLine) {
  const emit = (l) => { try { if (onLine) onLine(l); } catch { /* UI fechou */ } };
  const st = statusCodex(codexBin);
  if (st.installed) {
    return Promise.resolve({ ok: true, jaInstalado: true, versao: st.versao });
  }
  if (_installChild) {
    return Promise.resolve({ ok: false, error: 'Já existe uma instalação em andamento — aguarde.' });
  }
  return new Promise((resolve) => {
    const tail = [];
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
    const cmdNpm = `npm install -g @openai/codex@${CODEX_PIN}`;
    try {
      child = process.platform === 'win32'
        ? spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmdNpm],
          { windowsHide: true })
        : spawn('bash', ['-lc', cmdNpm], { detached: true });
    } catch (e) {
      return resolve({ ok: false, error: `Não foi possível iniciar o npm: ${e.message}` });
    }
    _installChild = child;
    child.stdout.setEncoding('utf-8'); child.stdout.on('data', push);
    child.stderr.setEncoding('utf-8'); child.stderr.on('data', push);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* já morreu */ } }, 5 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      _installChild = null;
      if (code === 0) {
        const dep = statusCodex(codexBin);
        return resolve(dep.installed
          ? { ok: true, versao: dep.versao }
          : { ok: false, error: 'npm terminou ok mas o codex não respondeu — abra um terminal novo e rode: codex --version' });
      }
      resolve({
        ok: false,
        error: `npm terminou com código ${code}. Instale manualmente: ${cmdNpm}. `
          + `Últimas linhas: ${tail.slice(-4).join(' | ').slice(0, 300)}`,
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      _installChild = null;
      resolve({ ok: false, error: `npm não encontrado (${e.message}) — instale o Node.js primeiro (nodejs.org) e rode: ${cmdNpm}` });
    });
  });
}

/** Abre `codex login` num terminal visível — GUI não tem TTY. */
function loginTerminal(codexBin) {
  const base = _resolve(codexBin);
  const linha = base.concat(['login']).map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'Codex login', 'cmd', '/k', linha],
        { windowsHide: true, detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e',
        `tell application "Terminal" to do script "${linha.replace(/"/g, '\\"')}"`,
        '-e', 'tell application "Terminal" to activate'], { detached: true }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', linha], { detached: true }).unref();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Não abriu o terminal: ${e.message}. Rode à mão: codex login` };
  }
}

module.exports = { statusCodex, instalarCodex, loginTerminal, CODEX_PIN };
