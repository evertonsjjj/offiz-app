// Verificador/instalador de dependências por prédio (escritório).
//
// O pareamento guarda em cfg.dependencias o que os offices da organização
// declaram em office.json ("dependencias": binários como ffmpeg e pacotes
// python como python-docx). Este módulo checa cada item e instala COM
// CONSENTIMENTO (um clique por item na UI do motor).
//
// SEGURANÇA (invariante): o nome vindo do servidor é usado SOMENTE como CHAVE
// no mapa DEPS_CONHECIDAS (whitelist fixa, argv hardcoded). NUNCA executamos
// string vinda do servidor — dependência fora do mapa vira instrução manual
// ("instale manualmente: <nome>").
//
// Por SO: Windows → winget/py; macOS → brew/python3 (sem brew, mostramos a
// instrução de instalar o Homebrew — não tentamos instalar o brew sozinhos);
// Linux → sem instalador automático (gerenciador de pacotes varia), só dica.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { killProcessTree } = require('./claude-runtime');

const CHECK_TIMEOUT_MS = 8000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000; // winget/brew baixam pacotes grandes

// PATH aumentado: app GUI herda um PATH que não vê instalações novas.
// *nix: lançado pelo Finder, sem homebrew/~/.local/bin (racional do
// claude-manager). Windows: o winget grava em diretórios novos e atualiza o
// PATH só no REGISTRO — o processo Electron já em execução nunca vê; sem o
// prepend a re-verificação pós-install falharia sempre em máquina limpa.
function _env() {
  const env = { ...process.env };
  const home = os.homedir() || '';
  let extras;
  if (process.platform === 'win32') {
    const localApp = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    extras = [
      path.join(localApp, 'Microsoft', 'WinGet', 'Links'), // ffmpeg e afins
      path.join(localApp, 'Programs', 'Python', 'Launcher'), // py.exe
      path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'),
      path.join(home, '.local', 'bin'), // instalador nativo do claude
    ];
  } else {
    extras = ['/opt/homebrew/bin', '/usr/local/bin',
      path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin')];
  }
  const chave = process.platform === 'win32' ? 'Path' : 'PATH';
  const cur = (env[chave] || env.PATH || '').split(path.delimiter).filter(Boolean);
  env[chave] = extras.filter((d) => !cur.includes(d)).concat(cur).join(path.delimiter);
  if (chave !== 'PATH') env.PATH = env[chave];
  return env;
}

// Lookup SEGURO na whitelist: nome vem do servidor — sem hasOwnProperty um
// nome como "__proto__"/"constructor" acharia entrada na cadeia de protótipos
// e seria classificado como "conhecida" (sem execução, mas confunde a UI).
function _entryDe(nome) {
  return Object.prototype.hasOwnProperty.call(DEPS_CONHECIDAS, nome)
    ? DEPS_CONHECIDAS[nome]
    : undefined;
}

// Argv do winget com os aceites de licença (instalação silenciosa, sem admin).
function _winget(id) {
  return ['winget', 'install', '--id', id, '-e',
    '--accept-source-agreements', '--accept-package-agreements'];
}

// Pacote python (pip): check via `pip show`, instala com --user (sem admin).
// Requer python3 na máquina — se faltar, o check falha e a UI mostra os dois.
function _pip(pkg) {
  return {
    check: {
      win32: ['py', '-m', 'pip', 'show', pkg],
      default: ['python3', '-m', 'pip', 'show', pkg],
    },
    install: {
      win32: ['py', '-m', 'pip', 'install', '--user', pkg],
      darwin: ['python3', '-m', 'pip', 'install', '--user', pkg],
    },
    manual: `pip install ${pkg}`,
  };
}

// ─── Whitelist: TODA execução sai daqui, nunca do servidor ──────────────────
const DEPS_CONHECIDAS = {
  ffmpeg: {
    check: { default: ['ffmpeg', '-version'] },
    install: {
      win32: _winget('Gyan.FFmpeg'),
      darwin: ['brew', 'install', 'ffmpeg'],
    },
    manual: 'https://ffmpeg.org/download.html',
  },
  python3: {
    check: {
      win32: ['py', '--version'],
      default: ['python3', '--version'],
    },
    install: {
      win32: _winget('Python.Python.3.12'),
      darwin: ['brew', 'install', 'python'],
    },
    manual: 'https://www.python.org/downloads/',
  },
  git: {
    check: { default: ['git', '--version'] },
    install: {
      win32: _winget('Git.Git'),
      darwin: ['brew', 'install', 'git'],
    },
    manual: 'https://git-scm.com/downloads',
  },
  // Pacotes python que os offices atuais declaram (juris/financeiro/etc.).
  'python-docx': _pip('python-docx'),
  'python-pptx': _pip('python-pptx'),
  openpyxl: _pip('openpyxl'),
  httpx: _pip('httpx'),
};

function _argvPorSo(spec) {
  if (!spec) return null;
  return spec[process.platform] || spec.default || null;
}

/** Homebrew presente? (mac) — caminho fixo primeiro, `which` como fallback. */
function _brewDisponivel() {
  if (process.platform !== 'darwin') return false;
  if (fs.existsSync('/opt/homebrew/bin/brew') || fs.existsSync('/usr/local/bin/brew')) return true;
  const r = spawnSync('which', ['brew'], { encoding: 'utf-8', env: _env() });
  return !r.error && r.status === 0;
}

/** Roda o check de UMA dependência conhecida. Devolve { instalada, versao }. */
function _checar(entry) {
  const argv = _argvPorSo(entry.check);
  if (!argv) return { instalada: null, versao: null };
  const r = spawnSync(argv[0], argv.slice(1), {
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf-8',
    env: _env(),
  });
  if (r.error || r.status !== 0) return { instalada: false, versao: null };
  const primeira = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split(/\r?\n/)[0] || '';
  return { instalada: true, versao: primeira.slice(0, 80) || null };
}

/**
 * Verifica a lista de dependências (nomes vindos do cfg). NUNCA lança.
 * Cada item: { nome, conhecida, instalada (true|false|null), versao,
 *              instalavel, brewAusente, manual }.
 */
function verificarDeps(nomes) {
  const out = [];
  for (const bruto of Array.isArray(nomes) ? nomes : []) {
    const nome = String(bruto || '').trim();
    if (!nome) continue;
    const entry = _entryDe(nome);
    if (!entry) {
      // Fora da whitelist: nunca executa nada — só orienta.
      out.push({
        nome, conhecida: false, instalada: null, versao: null,
        instalavel: false, brewAusente: false,
        manual: `instale manualmente: ${nome}`,
      });
      continue;
    }
    let st;
    try { st = _checar(entry); } catch { st = { instalada: null, versao: null }; }
    const argvInstall = _argvPorSo(entry.install);
    const precisaBrew = Boolean(argvInstall && argvInstall[0] === 'brew');
    const brewAusente = precisaBrew && !_brewDisponivel();
    out.push({
      nome,
      conhecida: true,
      instalada: st.instalada,
      versao: st.versao,
      instalavel: Boolean(argvInstall) && !brewAusente,
      brewAusente,
      manual: entry.manual || null,
    });
  }
  return out;
}

// ─── Instalação (um item por vez, com log ao vivo) ──────────────────────────

let _installChild = null;

/**
 * Instala UMA dependência da whitelist. onLine(linha) recebe a saída ao vivo.
 * NUNCA lança — devolve { ok, versao? } ou { ok:false, error, brewAusente?, log? }.
 */
function instalarDep(nome, onLine) {
  const emit = (linha) => { try { if (onLine) onLine(linha); } catch { /* UI fechou */ } };
  const chave = String(nome || '').trim();
  const entry = _entryDe(chave);

  // Whitelist: nome desconhecido NUNCA vira execução.
  if (!entry) {
    return Promise.resolve({ ok: false, error: `Dependência fora do mapa conhecido — instale manualmente: ${chave}` });
  }
  const argv = _argvPorSo(entry.install);
  if (!argv) {
    return Promise.resolve({
      ok: false,
      error: `Sem instalador automático para este sistema — instale manualmente: ${entry.manual || chave}`,
    });
  }
  if (argv[0] === 'brew' && !_brewDisponivel()) {
    // Não instalamos o brew sozinhos: é uma decisão do dono da máquina.
    return Promise.resolve({
      ok: false, brewAusente: true,
      error: 'Homebrew não encontrado. Instale-o primeiro (https://brew.sh) e clique de novo em Instalar.',
    });
  }
  if (_installChild) {
    return Promise.resolve({ ok: false, error: 'Já existe uma instalação em andamento — aguarde ela terminar.' });
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
    try {
      child = spawn(argv[0], argv.slice(1), {
        windowsHide: true,
        env: _env(),
        // Grupo próprio no *nix: o cancelamento por timeout mata a ÁRVORE
        // (winget/brew disparam sub-instaladores que ficariam órfãos).
        detached: process.platform !== 'win32',
      });
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
      emit(`[Offiz] A instalação de ${chave} passou de 10 minutos — cancelando.`);
      // Mata a ÁRVORE (taskkill /T no Windows, grupo no *nix): matar só o
      // winget deixaria um msiexec órfão segurando o mutex do MSI — o retry
      // seguinte colidiria com ele e falharia de forma confusa.
      try { killProcessTree(child); } catch { /* já morreu */ }
      finish({ ok: false, error: `A instalação de ${chave} demorou demais e foi cancelada.`, log: tail.slice(-8) });
    }, INSTALL_TIMEOUT_MS);

    if (child.stdout) { child.stdout.setEncoding('utf-8'); child.stdout.on('data', push); }
    if (child.stderr) { child.stderr.setEncoding('utf-8'); child.stderr.on('data', push); }
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: `O instalador não rodou: ${e.message}`, log: tail.slice(-8) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Exit 0 não basta: re-checa de verdade (winget às vezes sai 0 sem instalar).
      let depois;
      try { depois = _checar(entry); } catch { depois = { instalada: null }; }
      if (depois.instalada) {
        finish({ ok: true, versao: depois.versao || null });
      } else {
        finish({
          ok: false,
          error: code === 0
            ? `O instalador terminou, mas ${chave} ainda não respondeu — pode ser preciso reiniciar o app.`
            : `O instalador de ${chave} terminou com código ${code}.`,
          log: tail.slice(-8),
        });
      }
    });
  });
}

module.exports = { DEPS_CONHECIDAS, verificarDeps, instalarDep };
