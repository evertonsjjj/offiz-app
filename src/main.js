// Offiz Standalone — casca desktop.
//
// A janela principal é o PRÓPRIO SITE (espelho: toda a UI/engine ficam no
// servidor — o app nunca desatualiza). O que o app adiciona é o MOTOR LOCAL:
// um worker que roda os jobs da organização do cliente com o Claude Code CLI
// dele (modo cli = assinatura própria, sem custo por token no Offiz).
//
// Pareamento: o cliente faz login NO SITE (janela principal); o app lê o JWT
// do localStorage do webview, descobre as organizações dele e troca por um
// token de worker escopado (POST /api/v1/orgs/{id}/worker-token) — guardado
// cifrado via safeStorage. Sem copiar/colar token.
//
// Janela única: o painel do motor é EMBUTIDO no site via window.offizMotor
// (preload-site.js + guard de origem nos handlers IPC); quando a dupla
// "pareado + Claude conectado" se completa, o main troca o motor da org para
// 'cli' automaticamente (talvezTrocarModoCli). O motor.html continua como
// fallback interno de depuração.

'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const config = require('./motor/config');
const { apiV1 } = require('./motor/backend-client');
const { MotorWorker } = require('./motor/worker');
const { CriadorSessao } = require('./motor/criador');
const claudeManager = require('./motor/claude-manager');
const depsManager = require('./motor/deps-manager');
const { origemAutorizada } = require('./motor/origem');

// URL file:// exata do motor.html empacotado — o guard de origem só aceita
// ESTE file:// (um .html arrastado para a janela não ganha a ponte).
const MOTOR_HTML_URL = pathToFileURL(path.join(__dirname, 'motor.html')).href;

let cfg = null;
let siteWin = null;
let motorWin = null;
let worker = null;
let criador = null;

// ─── Proteções do motor local (tarefa rodando × ciclo de vida do app) ───────
//
// Bug real de produção: o usuário fechava o app (ou o PC dormia) com uma
// tarefa em execução — o motor sumia sem avisar e o job morria como ÓRFÃO só
// depois do timeout do sweeper no servidor. Três proteções:
// 1. fechar com tarefa rodando pede confirmação (dialog síncrono);
// 2. confirmou → best-effort: devolve o job à fila (POST liberar, ~3s) e mata
//    o processo do Claude antes de sair — a tarefa recomeça do zero quando um
//    motor religar;
// 3. powerSaveBlocker impede a SUSPENSÃO do PC enquanto houver job rodando
//    (suspensão congelava o heartbeat e o servidor matava o job como órfão).

let saidaConfirmada = false; // já confirmou o fechamento — não perguntar de novo

function confirmarFechamentoComTarefa(event) {
  if (saidaConfirmada) return; // liberação já em curso — deixa fechar
  if (!worker || !worker.jobAtual) return; // sem tarefa — fecha normal
  const escolha = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'Tarefa em execução',
    message: 'Uma tarefa está rodando nesta máquina.',
    detail: 'Fechar o Offiz interrompe a execução e a tarefa volta para a fila ' +
      '(recomeça do zero quando o motor religar).',
    buttons: ['Cancelar', 'Fechar mesmo assim'],
    defaultId: 0,
    cancelId: 0,
  });
  if (escolha === 0) {
    event.preventDefault();
    return;
  }
  // Confirmado: segura ESTE fechamento só o suficiente para o liberar
  // assíncrono correr (timeout curto — o quit nunca fica pendurado).
  saidaConfirmada = true;
  event.preventDefault();
  encerrarComLiberacao();
}

async function encerrarComLiberacao() {
  try {
    // worker.stop() esperaria o job INTEIRO terminar — aqui é fire-and-forget
    // (só desliga o loop de claims); quem devolve o job é o liberar.
    worker.stop().catch(() => {});
    await Promise.race([
      worker.liberarJobAtual(3000),
      new Promise((r) => setTimeout(r, 4000)), // teto geral: nunca travar o quit
    ]);
  } catch { /* best-effort */ }
  // Mata o Claude DEPOIS do liberar: o finish(failed) que o kill dispararia
  // chega com o job já de volta na fila — o backend o rejeita (409).
  try { worker.matarProcessoAtual(); } catch { /* best-effort */ }
  // Sessão do criador: só mata o processo do turno (a pasta de trabalho FICA —
  // nada foi publicado, e apagar no quit jogaria fora a edição em andamento;
  // o próximo abrir() do mesmo slug recomeça limpo de qualquer forma).
  try { if (criador) criador.cancelar(); } catch { /* best-effort */ }
  app.exit(0);
}

// PC não dorme com tarefa rodando (proteção 3). 'prevent-app-suspension'
// mantém o processo vivo com a tampa fechada/economia de energia — a tela
// pode apagar; o job continua e o heartbeat não some.
let bloqueioSuspensaoId = null;

function atualizarBloqueioSuspensao() {
  const rodando = Boolean(worker && worker.jobAtual);
  if (rodando && bloqueioSuspensaoId === null) {
    bloqueioSuspensaoId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!rodando && bloqueioSuspensaoId !== null) {
    if (powerSaveBlocker.isStarted(bloqueioSuspensaoId)) {
      powerSaveBlocker.stop(bloqueioSuspensaoId);
    }
    bloqueioSuspensaoId = null;
  }
}

// ─── Janelas ────────────────────────────────────────────────────────────────

// Marcador de desktop no userAgent: o site detecta "OffizDesktop/x.y.z" para
// saber que está rodando dentro do executável (e não num navegador comum).
// Idempotente: nunca acrescenta o marcador duas vezes.
function marcarUaDesktop(uaBase) {
  const ua = String(uaBase || '').trim();
  if (ua.includes('OffizDesktop/')) return ua;
  return `${ua} OffizDesktop/${app.getVersion()}`;
}

function criarJanelaSite(urlInicial) {
  siteWin = new BrowserWindow({
    width: 1360,
    height: 880,
    title: 'Offiz',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:offiz-site', // sessão persistente: login sobrevive a restart
      // Ponte window.offizMotor: o site (feature-detect) embute o painel do
      // motor na própria página — janela única. Os handlers IPC têm guard de
      // origem (handleSeguro), então navegação inesperada não ganha a ponte.
      preload: path.join(__dirname, 'preload-site.js'),
      // Versão do app para o preload via argv — sem canal IPC só para isso.
      additionalArguments: [`--offiz-versao=${app.getVersion()}`],
    },
  });
  // ANTES do load: setUserAgent no webContents vale para TODA navegação e
  // reload subsequentes desta janela (o fallback global cobre o resto).
  siteWin.webContents.setUserAgent(marcarUaDesktop(siteWin.webContents.getUserAgent()));
  siteWin.loadURL(urlInicial || cfg.siteUrl);
  // Fechar a janela do site com tarefa rodando = fechar o motor (window-all-
  // closed encerra o app) — pede confirmação e libera o job com elegância.
  siteWin.on('close', confirmarFechamentoComTarefa);
  siteWin.on('closed', () => { siteWin = null; });
  // Links externos (WhatsApp, OAuth da Anthropic, etc.) → navegador padrão.
  siteWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Navegação IN-PLACE fora do site (drag-and-drop de .html, redirect
  // suspeito) não acontece nesta janela: o preload persiste em qualquer
  // navegação, então só o próprio site pode ocupá-la. Links http(s) de
  // terceiros vão para o navegador padrão; file:// e afins só são bloqueados.
  siteWin.webContents.on('will-navigate', (event, url) => {
    if (origemAutorizada(url, cfg.siteUrl, null)) return; // o próprio site
    event.preventDefault();
    if (/^https?:/i.test(String(url))) {
      shell.openExternal(url).catch(() => { /* url estranha — só bloqueia */ });
    }
  });
}

function abrirJanelaMotor() {
  if (motorWin) { motorWin.focus(); return; }
  motorWin = new BrowserWindow({
    width: 560,
    height: 760,
    title: 'Offiz — Motor local',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload-motor.js'),
    },
  });
  motorWin.loadFile(path.join(__dirname, 'motor.html'));
  motorWin.on('closed', () => { motorWin = null; });
}

// Push para os DOIS consumidores da ponte: o painel embutido no site (janela
// principal) e o motor.html (fallback interno de depuração), quando abertos.
// O push para a janela do site passa pelo MESMO guard de origem dos invokes:
// se a janela navegou para fora do site, nada é enviado (o log do instalador
// carrega caminhos locais/nome de usuário).
function enviarParaPaineis(canal, ...args) {
  if (siteWin && !siteWin.isDestroyed()
      && origemAutorizada(siteWin.webContents.getURL(), cfg.siteUrl, MOTOR_HTML_URL)) {
    siteWin.webContents.send(canal, ...args);
  }
  if (motorWin && !motorWin.isDestroyed()) {
    motorWin.webContents.send(canal, ...args);
  }
}

function notificarMotorUI() {
  enviarParaPaineis('motor-update');
}

// Janela única: o painel do motor vive DENTRO do site (a página detecta
// window.offizMotor). O menu navega a janela principal para a página certa;
// pareado → Configurações da org (onde mora o painel), senão → prédios.
function irParaMotorNoSite() {
  const base = String(cfg.siteUrl || '').replace(/\/+$/, '');
  const destino = cfg.orgId ? `${base}/config/org/${cfg.orgId}` : `${base}/predios`;
  if (siteWin && !siteWin.isDestroyed()) {
    siteWin.loadURL(destino);
    siteWin.focus();
  } else {
    criarJanelaSite(destino);
  }
}

// ─── Menu (PT-BR, com roles de edição para copiar/colar funcionar no Mac) ───

function montarMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Offiz',
      submenu: [
        { label: 'Voltar ao site', click: () => { if (siteWin) siteWin.loadURL(cfg.siteUrl); else criarJanelaSite(); } },
        { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => siteWin && siteWin.webContents.reload() },
        { type: 'separator' },
        // Janela única: leva à página do site que embute o painel do motor.
        { label: 'Motor local…', accelerator: 'CmdOrCtrl+M', click: irParaMotorNoSite },
        // Fallback interno (motor.html) — SÓ em build de dev (o leigo do app
        // empacotado nunca vê a segunda janela).
        ...(app.isPackaged ? [] : [{ label: 'Motor local (janela de depuração)…', click: abrirJanelaMotor }]),
        { type: 'separator' },
        { role: 'quit', label: 'Sair' },
      ],
    },
    { role: 'editMenu', label: 'Editar' },
    {
      label: 'Ver',
      submenu: [
        { role: 'zoomIn', label: 'Aumentar zoom' },
        { role: 'zoomOut', label: 'Diminuir zoom' },
        { role: 'resetZoom', label: 'Zoom padrão' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'DevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Pareamento (site → JWT → token de worker da org) ───────────────────────

async function lerTokenDoSite() {
  if (!siteWin || siteWin.isDestroyed()) return null;
  try {
    const tok = await siteWin.webContents.executeJavaScript(
      "localStorage.getItem('offiz_access_token')", true
    );
    return tok || null;
  } catch {
    return null;
  }
}

// ─── Troca automática do motor da org (regra de produto) ────────────────────
//
// O worker local só recebe jobs de org em motor_modo='cli' — e o backend NUNCA
// entrega a chave API a worker escopado (guard em /internal). Sem esta troca o
// motor ficaria eternamente "aguardando tarefas". Quando a dupla se completa
// (app pareado numa org + Claude conectado), o main tenta o PUT com o JWT do
// site. 403 (membro comum, sem poder de org) NÃO é erro: vira avisoModo.

const AVISO_MODO_SEM_PODER =
  "Peça ao dono/admin para trocar o Motor de execução para 'Claude Code CLI' " +
  'nas Configurações da organização.';

// Cache curto do claude-status: o handler 'claude-status' popula (a página
// consulta ao montar o painel, ANTES de o usuário clicar em Parear). Evita
// re-rodar o statusClaude síncrono (~10s de main travado) dentro do parear.
let _statusClaudeCache = { st: null, em: 0 };
const STATUS_CLAUDE_TTL_MS = 5 * 60 * 1000;

function statusClaudeCacheado() {
  const agora = Date.now();
  if (_statusClaudeCache.st && agora - _statusClaudeCache.em < STATUS_CLAUDE_TTL_MS) {
    return _statusClaudeCache.st;
  }
  const st = claudeManager.statusClaude(cfg.claudeBin);
  _statusClaudeCache = { st, em: agora };
  return st;
}

async function talvezTrocarModoCli({ assumirConectado = false } = {}) {
  if (!cfg.orgId) return { motorTrocado: false, avisoModo: null };
  if (!assumirConectado) {
    // Sessão ativa = instalado + (auth status diz logado OU a credencial em
    // disco existe e não venceu) — e nunca com token vencido. Usa o cache do
    // claude-status (a UI consulta ao montar) para não travar o main ~10s.
    const st = statusClaudeCacheado();
    const conectado = Boolean(st.installed)
      && (st.loggedIn === true || st.tokenExpired === false)
      && st.tokenExpired !== true;
    if (!conectado) return { motorTrocado: false, avisoModo: null };
  }
  const jwt = await lerTokenDoSite();
  if (!jwt) return { motorTrocado: false, avisoModo: null };
  try {
    await apiV1(cfg.backendUrl, jwt, 'PUT', `/orgs/${cfg.orgId}/settings/llm`,
      { motor_modo: 'cli' });
    return { motorTrocado: true, avisoModo: null };
  } catch (e) {
    if (e && e.status === 403) {
      return { motorTrocado: false, avisoModo: AVISO_MODO_SEM_PODER };
    }
    // Rede/servidor: best-effort — o pareamento/login em si continua válido.
    return {
      motorTrocado: false,
      avisoModo: `A troca automática do motor falhou (${e.message}) — ` +
        'ajuste nas Configurações da organização.',
    };
  }
}

// ─── IPC do painel do motor ─────────────────────────────────────────────────

// Registra um handler IPC recusando chamadas de origem não autorizada: só o
// site configurado (cfg.siteUrl) e o motor.html local (file://) podem falar
// com o motor — navegação inesperada na janela não ganha a ponte.
function handleSeguro(canal, fn) {
  ipcMain.handle(canal, (event, ...args) => {
    let urlChamador = '';
    try {
      urlChamador = (event.senderFrame && event.senderFrame.url) || event.sender.getURL();
    } catch { /* frame já destruído — cai na recusa */ }
    if (!origemAutorizada(urlChamador, cfg.siteUrl, MOTOR_HTML_URL)) {
      return { ok: false, error: 'origem não autorizada' };
    }
    return fn(event, ...args);
  });
}

function registrarIpc() {
  handleSeguro('motor-estado', () => ({
    config: {
      siteUrl: cfg.siteUrl,
      backendUrl: cfg.backendUrl,
      orgId: cfg.orgId,
      orgNome: cfg.orgNome,
      pareadoPor: cfg.pareadoPor,
      dependencias: cfg.dependencias || [],
      claudeBin: cfg.claudeBin,
    },
    pareado: Boolean(cfg.orgId && config.getWorkerToken(cfg)),
    worker: {
      estado: worker.estado,
      jobAtual: worker.jobAtual,
      log: worker.logLines,
    },
  }));

  // Estado do Claude é spawnSync (até ~10s) — handler separado, sob demanda.
  // Alimenta o cache usado por talvezTrocarModoCli (parear não trava o main).
  handleSeguro('claude-status', () => {
    const st = claudeManager.statusClaude(cfg.claudeBin);
    _statusClaudeCache = { st, em: Date.now() };
    return st;
  });

  handleSeguro('motor-orgs', async () => {
    const jwt = await lerTokenDoSite();
    if (!jwt) return { ok: false, error: 'Faça login no site primeiro (janela principal do app).' };
    try {
      const me = await apiV1(cfg.backendUrl, jwt, 'GET', '/auth/me');
      const predios = await apiV1(cfg.backendUrl, jwt, 'GET', '/predios');
      const orgs = [];
      for (const p of Array.isArray(predios) ? predios : (predios.predios || [])) {
        if (!orgs.some((o) => o.id === p.org_id)) {
          orgs.push({ id: p.org_id, nome: p.org_nome || `Organização ${p.org_id}` });
        }
      }
      return { ok: true, usuario: me.nome || me.email, orgs };
    } catch (e) {
      return { ok: false, error: `Não foi possível listar as organizações: ${e.message}` };
    }
  });

  handleSeguro('motor-parear', async (_ev, orgId) => {
    const jwt = await lerTokenDoSite();
    if (!jwt) return { ok: false, error: 'Faça login no site primeiro (janela principal do app).' };
    try {
      // Qualquer membro ATIVO pode parear (o backend emite token por membro).
      const r = await apiV1(cfg.backendUrl, jwt, 'POST', `/orgs/${orgId}/worker-token`);
      // Quem pareou: nome do usuário logado (exibido no painel do motor).
      const me = await apiV1(cfg.backendUrl, jwt, 'GET', '/auth/me').catch(() => null);
      const predios = await apiV1(cfg.backendUrl, jwt, 'GET', '/predios');
      const daOrg = (Array.isArray(predios) ? predios : (predios.predios || []))
        .filter((x) => x.org_id === orgId);
      cfg.orgId = orgId;
      cfg.orgNome = (daOrg[0] && daOrg[0].org_nome) || `Organização ${orgId}`;
      cfg.pareadoPor = me ? (me.nome || me.email || '') : '';
      // Dependências declaradas pelos offices da org (office.json →
      // "dependencias") — o verificador do painel checa/instala com consentimento.
      const deps = [];
      for (const x of daOrg) {
        const arr = (x.office && Array.isArray(x.office.dependencias)) ? x.office.dependencias : [];
        for (const d of arr) {
          const nome = String(d || '').trim();
          if (nome && !deps.includes(nome)) deps.push(nome);
        }
      }
      cfg.dependencias = deps;
      config.setWorkerToken(cfg, r.token);
      config.save(cfg);
      notificarMotorUI();
      // A dupla pode ter se completado agora (org pareada + Claude já
      // conectado antes) → tenta a troca automática do motor para 'cli'.
      const troca = await talvezTrocarModoCli();
      return {
        ok: true,
        orgNome: cfg.orgNome,
        keyPrefix: r.key_prefix,
        pareadoPor: cfg.pareadoPor,
        dependencias: deps,
        motorTrocado: troca.motorTrocado,
        avisoModo: troca.avisoModo,
      };
    } catch (e) {
      const msg = e.status === 403
        ? 'Sua conta não tem acesso a esta organização — confirme o login.'
        : e.message;
      return { ok: false, error: `Pareamento falhou: ${msg}` };
    }
  });

  handleSeguro('motor-desparear', async () => {
    // Best-effort no servidor, com o login do site (ANTES de limpar cfg):
    // 1) volta o motor da org para 'api' — sem worker local pareado, deixar em
    //    'cli' pararia a fila (nenhum worker elegível pegaria os jobs);
    // 2) revoga o token de worker — só apagar o token local deixaria o
    //    offiz_wk_ válido no backend indefinidamente.
    const tinhaOrg = Boolean(cfg.orgId);
    let motorRestaurado = false;
    let revogadoNoServidor = false;
    let outraMaquinaPareada = false;
    if (tinhaOrg) {
      const jwt = await lerTokenDoSite();
      if (jwt) {
        // MULTI-MÁQUINA: o token é por MEMBRO — se outra máquina da org segue
        // pareada, virar a org para 'api' silenciaria o worker dela. Só
        // restaura 'api' quando ESTA é a última (lista com só o nosso
        // pareamento); se a listagem falhar (membro comum não vê /todos, ou
        // rede), NÃO arrisca o PUT global.
        let ehUltima = false;
        try {
          const r = await apiV1(
            cfg.backendUrl, jwt, 'GET', `/orgs/${cfg.orgId}/worker-token/todos`,
          );
          const lista = Array.isArray(r) ? r : (r && r.pareamentos) || [];
          ehUltima = lista.length <= 1; // a nossa ainda está na lista
          outraMaquinaPareada = lista.length > 1;
        } catch { /* sem visão de admin/rede — pula o PUT, vira aviso */ }
        if (ehUltima) {
          try {
            await apiV1(cfg.backendUrl, jwt, 'PUT', `/orgs/${cfg.orgId}/settings/llm`,
              { motor_modo: 'api' });
            motorRestaurado = true;
          } catch { /* 403 (membro comum) ou rede — vira aviso abaixo */ }
        }
        try {
          await apiV1(cfg.backendUrl, jwt, 'DELETE', `/orgs/${cfg.orgId}/worker-token`);
          revogadoNoServidor = true;
        } catch { /* sem rede — o dono ainda pode revogar pelo site */ }
      }
    }
    cfg.orgId = null;
    cfg.orgNome = '';
    cfg.pareadoPor = '';
    cfg.dependencias = [];
    config.setWorkerToken(cfg, '');
    config.save(cfg);
    notificarMotorUI();
    const avisos = [];
    if (tinhaOrg && !revogadoNoServidor) {
      avisos.push('Não deu para revogar no servidor (sem login/rede) — revogue em Configurações da organização no site.');
    }
    if (tinhaOrg && outraMaquinaPareada) {
      avisos.push("Há outra máquina pareada na organização — o Motor de execução continua em 'Claude Code CLI'.");
    } else if (tinhaOrg && !motorRestaurado) {
      avisos.push("Não deu para voltar o Motor de execução para 'Anthropic API' — peça ao dono/admin para ajustar nas Configurações da organização.");
    }
    return {
      ok: true,
      aviso: avisos.length ? avisos.join(' ') : null,
      motorRestaurado,
    };
  });

  handleSeguro('motor-ligar', () => { worker.start(); return { ok: true }; });
  handleSeguro('motor-desligar', async () => { await worker.stop(); return { ok: true }; });

  handleSeguro('motor-config-salvar', (_ev, novo) => {
    const siteMudou = novo.siteUrl && novo.siteUrl !== cfg.siteUrl;
    for (const k of ['siteUrl', 'backendUrl', 'claudeBin']) {
      if (typeof novo[k] === 'string') cfg[k] = novo[k].trim();
    }
    config.save(cfg);
    if (siteMudou && siteWin) siteWin.loadURL(cfg.siteUrl);
    return { ok: true };
  });

  // Fluxos do Claude CLI
  handleSeguro('claude-conectar', () =>
    claudeManager.loginStart(cfg.claudeBin, (url) => shell.openExternal(url)));
  handleSeguro('claude-conectar-aguardar', async () => {
    const r = await claudeManager.loginWait();
    if (!r || !r.ok) return r;
    // Login concluído = conectado (sem re-checar o status caro): se o app já
    // estiver pareado, esta é a outra metade da dupla → troca para 'cli'.
    const troca = await talvezTrocarModoCli({ assumirConectado: true });
    return { ...r, motorTrocado: troca.motorTrocado, avisoModo: troca.avisoModo };
  });
  handleSeguro('claude-conectar-cancelar', () => claudeManager.loginCancel());
  handleSeguro('claude-relogin-terminal', () => claudeManager.reloginTerminal(cfg.claudeBin));
  handleSeguro('claude-setup-token', () => claudeManager.setupTokenTerminal(cfg.claudeBin));

  // Instalação do Claude CLI com 1 clique (instalador oficial da Anthropic).
  // A saída é streamada linha a linha para o painel; ao final o binário
  // redetectado é fixado em cfg.claudeBin (apps GUI não enxergam o PATH novo).
  handleSeguro('claude-instalar', async () => {
    const r = await claudeManager.instalarClaude(cfg.claudeBin, (linha) => {
      enviarParaPaineis('claude-instalar-log', linha);
    });
    if (r.ok && r.bin) {
      cfg.claudeBin = r.bin;
      config.save(cfg);
    }
    return r;
  });

  // Dependências do escritório (cfg.dependencias, salvo no pareamento).
  // deps-status é spawnSync (checagens rápidas) — sob demanda, como o claude-status.
  handleSeguro('deps-status', () => depsManager.verificarDeps(cfg.dependencias || []));
  handleSeguro('deps-instalar', (_ev, nome) =>
    depsManager.instalarDep(nome, (linha) => {
      enviarParaPaineis('deps-instalar-log', linha);
    }));

  // ─── Criador de escritórios (página /criador do site, admin global) ───────
  //
  // UMA sessão por vez (é a máquina do consultor, como o worker é 1 job por
  // vez). O JWT vem do site A CADA chamada (lerTokenDoSite) — nunca fica
  // guardado aqui, e um logout no site derruba a próxima chamada com 403 do
  // backend, que é o comportamento certo. Eventos: canal 'criador-evento'.
  const respostaErro = (e) => ({ ok: false, error: e.message });

  handleSeguro('criador-abrir', async (_ev, slug) => {
    const jwt = await lerTokenDoSite();
    if (!jwt) return { ok: false, error: 'Faça login no site primeiro.' };
    try {
      const estado = await criador.abrir({ backendUrl: cfg.backendUrl, jwt, slug });
      return { ok: true, estado };
    } catch (e) { return respostaErro(e); }
  });

  // Fire-and-forget de propósito: um turno leva minutos e o invoke não pode
  // segurar a página — o término chega pelos eventos ('status' ocupado=false).
  handleSeguro('criador-enviar', (_ev, payload) => {
    try {
      criador.enviar({
        texto: payload && payload.texto,
        model: payload && payload.model,
        effort: payload && payload.effort,
      }).catch(() => { /* o erro já saiu como evento 'erro' */ });
      return { ok: true };
    } catch (e) { return respostaErro(e); }
  });

  handleSeguro('criador-cancelar', () => criador.cancelar());
  handleSeguro('criador-estado', () => ({ ok: true, estado: criador.estado() }));

  handleSeguro('criador-anexar', (_ev, payload) => {
    try {
      return criador.anexar({ arquivos: (payload && payload.arquivos) || [] });
    } catch (e) { return respostaErro(e); }
  });

  handleSeguro('criador-publicar', async () => {
    const jwt = await lerTokenDoSite();
    if (!jwt) return { ok: false, error: 'Faça login no site primeiro.' };
    try {
      const r = await criador.publicar({ backendUrl: cfg.backendUrl, jwt });
      return { ok: true, resposta: r.resposta };
    } catch (e) { return respostaErro(e); }
  });

  handleSeguro('criador-fechar', () => criador.fechar());
}

// ─── Boot ───────────────────────────────────────────────────────────────────

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (siteWin) { if (siteWin.isMinimized()) siteWin.restore(); siteWin.focus(); }
  });

  app.whenReady().then(() => {
    // Marcador global ANTES de criar qualquer janela: todo webContents novo
    // (inclusive após reload/navegação) nasce com "OffizDesktop/x.y.z" no UA.
    app.userAgentFallback = marcarUaDesktop(app.userAgentFallback);
    cfg = config.load();
    worker = new MotorWorker({
      getBackendUrl: () => cfg.backendUrl,
      getWorkerToken: () => config.getWorkerToken(cfg),
      getClaudeBin: () => cfg.claudeBin,
      workspacesRoot: path.join(app.getPath('userData'), 'workspaces'),
    });
    criador = new CriadorSessao({
      root: app.getPath('userData'),
      claudeBin: cfg.claudeBin,
    });
    criador.on('evento', (ev) => enviarParaPaineis('criador-evento', ev));
    worker.on('update', () => {
      notificarMotorUI();
      // Liga/desliga o bloqueio de suspensão conforme houver job rodando.
      atualizarBloqueioSuspensao();
    });

    montarMenu();
    registrarIpc();
    criarJanelaSite();

    // Janela única: o onboarding do motor acontece DENTRO do site (painel
    // embutido via window.offizMotor) — a primeira execução não abre mais o
    // motor.html; ele segue disponível no menu como fallback de depuração.

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) criarJanelaSite();
    });
  });

  // Sair pelo menu/Cmd+Q (sem passar pelo close da janela) também pede
  // confirmação se houver tarefa rodando — e libera o job antes de sair.
  app.on('before-quit', confirmarFechamentoComTarefa);

  // Um turno do criador rodando no quit viraria claude ÓRFÃO no SO (filho não
  // morre com o pai no Windows). Só mata o processo; a pasta de trabalho fica.
  app.on('will-quit', () => {
    try { if (criador) criador.cancelar(); } catch { /* best-effort */ }
  });

  app.on('window-all-closed', () => {
    // Fechar tudo encerra o app (inclusive o motor) — comportamento previsível
    // para o leigo; quem quiser o motor sempre vivo deixa a janela aberta.
    app.quit();
  });
}
