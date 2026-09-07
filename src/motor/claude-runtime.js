// Spawn do Claude Code CLI headless + parse do stream NDJSON (stream-json).
//
// Porta em Node do webapp/worker/claude_proc.py (que por sua vez veio do
// desktop C:/Offiz/Offiz/ipc/claude-runtime.js). Mantém o MESMO contrato de
// eventos do worker cloud: agent_text / tool_use / subagente / resultado.
//
// Modos de credencial (motor_modo do claim — o backend decide, aqui só se
// obedece):
// - "api": injeta a ANTHROPIC_API_KEY da organização (BYOK) — e, desde
//   20/08/2026, o ANTHROPIC_BASE_URL quando a org usa outro provedor
//   (OpenAI via gateway compatível): é assim que o motor LOCAL roda um job
//   de org OpenAI, com a chave e o endereço DELA. Toda credencial da máquina
//   é removida antes — o custo é sempre da org.
// - "cli": NÃO injeta chave nenhuma e preserva o login local do cliente
//   (claude login / CLAUDE_CODE_OAUTH_TOKEN) — roda na assinatura DELE.
//   Só acontece em org Anthropic; para as demais o claim manda "api".

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

function buildClaudeArgs(model, effort, sessionId, mcpConfigPath) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--effort', resolveEffort(effort),
    '--session-id', sessionId,
    '--dangerously-skip-permissions',
  ];
  // Sem declaração de MCP o argv fica EXATAMENTE como era: escritório que não
  // pede servidor nenhum não pode mudar de comportamento por causa deste
  // recurso (é o que o mcp-config-e2e chama de regressão).
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
    // --strict-mcp-config anda COLADO no --mcp-config: sem ele o CLI SOMA os
    // servidores pessoais da máquina do cliente (~/.claude.json, .mcp.json do
    // cwd) aos do escritório — ferramenta que ninguém declarou, com acesso a
    // dados de outra pessoa, dentro de um job da org. O motor local roda na
    // casa do cliente; é justamente aqui que essa mistura aconteceria.
    args.push('--strict-mcp-config');
  }
  return args;
}

// ---------------------------------------------------------------------------
// MCP — declaração do escritório (bloco `office.mcp_servers` do claim)
//
// ESPELHO do lado Python (webapp/worker): os dois motores consomem a MESMA
// declaração, e a normalização vive AQUI porque o codex-runtime é irmão deste
// arquivo e importa daqui (mesmo arranjo de codex_proc.py, que importa de
// claude_proc.py) — validação duplicada é validação que diverge.
//
// A LEI DA DECLARAÇÃO: ela carrega NOMES de variáveis de ambiente, nunca
// VALORES. Segredo em valor literal é descartado na normalização, e por isso
// nenhum segredo chega ao argv (que qualquer `ps` da máquina lê) nem ao
// arquivo de config. O valor de verdade viaja pelo env do processo, que o
// job_env já monta (buildClaudeEnv/buildCodexEnv).
// ---------------------------------------------------------------------------

// O nome vira caminho de chave de config no Codex (`-c mcp_servers.<nome>.…`):
// aceitar ponto/aspas aqui seria deixar a declaração escrever em QUALQUER
// chave do CLI. Whitelist estreita, não escape.
const MCP_NOME_OK = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_ENV_NOME_OK = /^[A-Za-z_][A-Za-z0-9_]{0,64}$/;
const MCP_CONFIG_NOME = '.offiz-mcp.json';

function _avisoMcpPadrao(msg) {
  // console.warn e não throw: MCP é acessório. Uma linha malformada no
  // manifesto do escritório não pode matar um job que faria o trabalho todo
  // sem servidor nenhum.
  console.warn('[mcp] ' + msg);
}

/**
 * Normaliza a declaração do claim em uma lista
 * [{nome, url, command, args, envDe, bearerTokenEnvVar}].
 *
 * Aceita mapa {nome: spec} e lista [{nome, …}] de propósito: o formato canônico
 * é o mapa (é o que o manifesto escreve), mas uma lista chegando do backend
 * não pode virar zero servidores em silêncio.
 *
 * Entrada malformada é IGNORADA COM AVISO, uma entrada por vez — o servidor
 * bom da linha de baixo continua valendo.
 */
function normalizarMcpServers(decl, avisar) {
  const avisa = typeof avisar === 'function' ? avisar : _avisoMcpPadrao;
  if (!decl) return [];
  let entradas;
  if (Array.isArray(decl)) {
    entradas = decl.map((spec) => [
      (spec && typeof spec === 'object' && (spec.nome || spec.name)) || '', spec,
    ]);
  } else if (typeof decl === 'object') {
    entradas = Object.entries(decl);
  } else {
    avisa('declaração ignorada: esperava mapa ou lista, veio ' + typeof decl);
    return [];
  }

  const out = [];
  const vistos = new Set();
  for (const [nomeBruto, spec] of entradas) {
    const nome = String(nomeBruto || '').trim();
    if (!MCP_NOME_OK.test(nome)) {
      avisa('servidor ignorado: nome inválido (' + JSON.stringify(nomeBruto) + ')');
      continue;
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      avisa('"' + nome + '" ignorado: a declaração não é um objeto');
      continue;
    }
    if (vistos.has(nome)) {
      avisa('"' + nome + '" ignorado: nome repetido na declaração');
      continue;
    }
    const url = typeof spec.url === 'string' ? spec.url.trim() : '';
    const command = typeof spec.command === 'string' ? spec.command.trim() : '';
    // XOR: os dois juntos é ambiguidade (qual transporte vale?) e nenhum é
    // declaração vazia. Nos dois casos o certo é não subir o servidor.
    if (Boolean(url) === Boolean(command)) {
      avisa('"' + nome + '" ignorado: declare url OU command — nunca os dois, nunca nenhum');
      continue;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      avisa('"' + nome + '" ignorado: url precisa ser http(s)');
      continue;
    }
    let args = [];
    if (command && spec.args !== undefined) {
      if (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== 'string')) {
        avisa('"' + nome + '" ignorado: args precisa ser lista de strings');
        continue;
      }
      args = spec.args.slice();
    }
    // `env_de` são NOMES de variáveis que o servidor precisa enxergar. Um
    // mapa `env` com valores (ou headers com token) é descartado sem dó: ver
    // "A LEI DA DECLARAÇÃO" acima.
    const envDe = [];
    for (const v of Array.isArray(spec.env_de) ? spec.env_de : []) {
      if (typeof v === 'string' && MCP_ENV_NOME_OK.test(v.trim())) envDe.push(v.trim());
      else avisa('"' + nome + '": env_de inválido descartado (' + JSON.stringify(v) + ')');
    }
    const bearerBruto = typeof spec.bearer_token_env_var === 'string'
      ? spec.bearer_token_env_var.trim() : '';
    const bearerTokenEnvVar = MCP_ENV_NOME_OK.test(bearerBruto) ? bearerBruto : '';
    if (bearerBruto && !bearerTokenEnvVar) {
      avisa('"' + nome + '": bearer_token_env_var inválido descartado');
    }
    vistos.add(nome);
    out.push({ nome, url, command, args, envDe, bearerTokenEnvVar });
  }
  return out;
}

/** Config no formato que o Claude Code lê (--mcp-config).
 *
 *  `${NOME}` em vez do valor: o CLI expande variáveis de ambiente ao carregar
 *  o arquivo, então o segredo continua só no env do processo — nem no argv,
 *  nem em disco no workspace (que é justamente o que o job zipa e sobe). */
function mcpConfigDoClaude(servidores) {
  const mcpServers = {};
  for (const s of servidores) {
    if (s.url) {
      const entrada = { type: 'http', url: s.url };
      if (s.bearerTokenEnvVar) {
        entrada.headers = { Authorization: 'Bearer ${' + s.bearerTokenEnvVar + '}' };
      }
      mcpServers[s.nome] = entrada;
    } else {
      const entrada = { type: 'stdio', command: s.command, args: s.args };
      if (s.envDe.length) {
        entrada.env = {};
        for (const nome of s.envDe) entrada.env[nome] = '${' + nome + '}';
      }
      mcpServers[s.nome] = entrada;
    }
  }
  return { mcpServers };
}

/** Materializa a config no workspace do job e devolve o caminho ('' se não há
 *  servidor válido ou se a escrita falhou — MCP nunca derruba o job). */
function escreverMcpConfig(workspaceDir, decl, avisar) {
  const avisa = typeof avisar === 'function' ? avisar : _avisoMcpPadrao;
  const servidores = normalizarMcpServers(decl, avisa);
  if (!servidores.length) return '';
  // No workspace do JOB (não em ~/.claude): a pasta é apagada no fim, então a
  // config morre com o job em vez de virar servidor permanente na máquina do
  // cliente. Nome com ponto para não ser confundido com material do escritório.
  const alvo = path.join(workspaceDir, MCP_CONFIG_NOME);
  try {
    fs.writeFileSync(alvo, JSON.stringify(mcpConfigDoClaude(servidores), null, 2), 'utf-8');
    return alvo;
  } catch (e) {
    avisa('config não pôde ser escrita (' + e.message + ') — o job segue sem MCP');
    return '';
  }
}

// ESPELHO de build_claude_env (webapp/worker/claude_proc.py) — o contrato da
// casa é que os dois mudam JUNTOS. `usaBearer` entra no FIM da lista de
// parâmetros de propósito: a assinatura é posicional e um parâmetro no meio
// quebraria os chamadores em silêncio.
function buildClaudeEnv(anthropicApiKey, motorModo, anthropicBaseUrl, usaBearer, extraEnv) {
  const env = { ...process.env };
  // Vars que, sobrando no ambiente, têm precedência sobre a chave injetada e
  // cobrariam a conta errada (ou dariam 401).
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  // Paridade com o worker cloud (worker/claude_proc.py) e com o irmão Codex:
  // o prompt do job é arbitrário e roda com Bash — o CLI nunca precisa das
  // coordenadas do worker, e herdá-las é dar a um prompt malicioso o caminho
  // para pedir claim de OUTRAS orgs.
  delete env.WORKER_TOKEN;
  delete env.BACKEND_URL;
  if (motorModo === 'cli') {
    // Modo CLI: preserva CLAUDE_CODE_OAUTH_TOKEN (se o cliente usou
    // `claude setup-token`) e deixa o CLI cair no login local. Nunca injeta.
  } else {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (anthropicApiKey) {
      // UMA variável, nunca as duas: AUTH_TOKEN vira "Authorization: Bearer"
      // (o que os gateways leem) e API_KEY vira "x-api-key" (a Anthropic
      // oficial). Qual vence com as duas setadas não é documentado de forma
      // consistente — não se depende do desempate.
      if (usaBearer) {
        env.ANTHROPIC_AUTH_TOKEN = anthropicApiKey;
        delete env.ANTHROPIC_API_KEY;
        // Upstream não-Anthropic recusa com 400 os campos experimentais.
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
      } else {
        env.ANTHROPIC_API_KEY = anthropicApiKey;
      }
    }
    // Endpoint do provedor da org (OpenAI via gateway). Entra DEPOIS do
    // delete lá em cima — a URL que valer é a do claim, nunca a da máquina.
    if (anthropicBaseUrl) env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
  }
  // Estúdio de mídia: o `job_env` do claim (FAL_KEY, ELEVENLABS_API_KEY…) entra
  // DEPOIS das remoções acima, com o mesmo filtro do worker cloud e do Codex —
  // job_env nunca sequestra a conta do run nem devolve as vars do worker.
  //
  // Isto faltava por inteiro no motor local (30/08/2026): o backend já mandava
  // `job_env` no claim desde 29/08 (backend/app/api/internal.py:871), e aqui a
  // função nem recebia o parâmetro. Resultado: quem pareava o Desktop para não
  // gastar API descobria que a peça saía SEM IMAGEM E SEM VOZ — o escritório
  // ficava só com o ffmpeg, e é por isso que uma peça que pedia estilização
  // saiu como filtro: não havia modelo nenhum ao alcance dele.
  for (const [chave, valor] of Object.entries(extraEnv || {})) {
    const alto = String(chave).toUpperCase();
    if (alto.startsWith('ANTHROPIC_') || alto.startsWith('CLAUDE_')
      || alto === 'WORKER_TOKEN' || alto === 'BACKEND_URL') continue;
    env[String(chave)] = String(valor);
  }
  env.PYTHONIOENCODING = 'utf-8';
  // PYTHONUTF8=1: os scripts do escritório rodam ffmpeg com text=True e, no
  // Windows, decodificam pela locale (cp1252) — um acento derruba a leitura.
  // Mesma linha do worker/claude_proc.py (05/09/2026).
  env.PYTHONUTF8 = '1';
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
function spawnClaude({ workspaceDir, prompt, model, effort, sessionId, anthropicApiKey, motorModo, anthropicBaseUrl, usaBearer, claudeBin, extraEnv, mcpServers }) {
  const base = resolveClaudeCmd(claudeBin);
  // A config precisa existir em disco ANTES do spawn: o CLI lê o --mcp-config
  // na largada. Sem declaração (ou com declaração toda inválida) o caminho vem
  // vazio e o argv fica idêntico ao de sempre.
  const mcpConfigPath = escreverMcpConfig(workspaceDir, mcpServers);
  const args = base.slice(1).concat(buildClaudeArgs(model, effort, sessionId, mcpConfigPath));

  const proc = spawn(base[0], args, {
    cwd: workspaceDir,
    env: buildClaudeEnv(anthropicApiKey, motorModo, anthropicBaseUrl, usaBearer, extraEnv),
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
    // Servidores de MCP que o init reportou fora do ar — a tela ja soube
    // na hora (ver _parseSystem); isto fica para quem quiser contar no fim.
    this.mcpFalhos = [];
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
    if (t === 'system') return this._parseSystem(ev);
    if (t === 'assistant') return this._parseAssistant(ev);
    if (t === 'user') return this._parseUser(ev);
    if (t === 'result') return this._parseResult(ev);
    return []; // rate_limit_event etc.
  }

  /* system/init: o UNICO lugar onde o CLI diz se um servidor de MCP conectou.
     Espelho de claude_proc.py::_parse_system — e o espelho ESTAVA PELA
     METADE: a fiacao de MCP foi para os dois motores, a observabilidade so
     para o Python. Na nuvem o servidor caido virava alarme na tela; aqui, na
     maquina do cliente, o job rodava inteiro sem a ferramenta com cara de
     normalidade. E o pior lugar para essa falha ser muda.

     Sai como `erro` porque e o unico dos cinco eventos do protocolo que a tela
     pinta como alerta — tipo novo cairia no default do switch e seria mudo de
     novo. `erro` NAO marca o job como failed: quem decide o status e o result. */
  _parseSystem(ev) {
    if (ev.subtype !== 'init') return [];
    const out = [];
    for (const srv of Array.isArray(ev.mcp_servers) ? ev.mcp_servers : []) {
      if (!srv || typeof srv !== 'object') continue;
      const status = String(srv.status || '').trim().toLowerCase();
      // Status ausente nao vira alarme: melhor calar do que assustar por
      // mudanca de shape do CLI. Falta de conexao ele diz com todas as letras.
      if (!status || status === 'connected') continue;
      const nome = String(srv.name || '').trim() || 'sem nome';
      this.mcpFalhos.push(nome);
      out.push({
        tipo: 'erro',
        payload: {
          mensagem:
            `A ferramenta externa "${nome}" não conectou (status: ${status}). ` +
            'O trabalho segue SEM ela — o que dependia dessa fonte pode sair ' +
            'incompleto.',
        },
      });
    }
    return out;
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
    if (name.startsWith('mcp__')) {
      // Espelho de claude_proc.py: ferramenta de MCP chega como
      // `mcp__<servidor>__<tool>`, e esse nome cru ia direto para o diario e
      // para a tela do cliente leigo. O mesmo destino que o Codex ja da ao
      // `mcp_tool_call` — ferramenta "Task" — vale aqui: a tela traduz "Task"
      // para "acionando especialista", e servidor/tool viram o resumo legivel.
      const partes = name.split('__');
      const servidor = partes.length > 1 ? partes[1] : '';
      const ferramentaMcp = partes.slice(2).join('__').replace(/_/g, ' ').trim();
      const resumo = [servidor, ferramentaMcp].filter(Boolean).join(' · ');
      return {
        tipo: 'tool_use',
        payload: { ferramenta: 'Task', resumo: resumo.slice(0, RESUMO_MAX) },
      };
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
  normalizarMcpServers,
  mcpConfigDoClaude,
  escreverMcpConfig,
  MCP_CONFIG_NOME,
  resolveClaudeCmd,
  claudeCandidates,
  spawnClaude,
  killProcessTree,
  StreamJsonParser,
};
