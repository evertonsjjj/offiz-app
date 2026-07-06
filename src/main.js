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

'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');

const config = require('./motor/config');
const { apiV1 } = require('./motor/backend-client');
const { MotorWorker } = require('./motor/worker');
const claudeManager = require('./motor/claude-manager');

let cfg = null;
let siteWin = null;
let motorWin = null;
let worker = null;

// ─── Janelas ────────────────────────────────────────────────────────────────

function criarJanelaSite() {
  siteWin = new BrowserWindow({
    width: 1360,
    height: 880,
    title: 'Offiz',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:offiz-site', // sessão persistente: login sobrevive a restart
    },
  });
  siteWin.loadURL(cfg.siteUrl);
  siteWin.on('closed', () => { siteWin = null; });
  // Links externos (WhatsApp, OAuth da Anthropic, etc.) → navegador padrão.
  siteWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
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

function notificarMotorUI() {
  if (motorWin && !motorWin.isDestroyed()) {
    motorWin.webContents.send('motor-update');
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
        { label: 'Motor local…', accelerator: 'CmdOrCtrl+M', click: abrirJanelaMotor },
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

// ─── IPC do painel do motor ─────────────────────────────────────────────────

function registrarIpc() {
  ipcMain.handle('motor-estado', () => ({
    config: {
      siteUrl: cfg.siteUrl,
      backendUrl: cfg.backendUrl,
      orgId: cfg.orgId,
      orgNome: cfg.orgNome,
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
  ipcMain.handle('claude-status', () => claudeManager.statusClaude(cfg.claudeBin));

  ipcMain.handle('motor-orgs', async () => {
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

  ipcMain.handle('motor-parear', async (_ev, orgId) => {
    const jwt = await lerTokenDoSite();
    if (!jwt) return { ok: false, error: 'Faça login no site primeiro (janela principal do app).' };
    try {
      const r = await apiV1(cfg.backendUrl, jwt, 'POST', `/orgs/${orgId}/worker-token`);
      const predios = await apiV1(cfg.backendUrl, jwt, 'GET', '/predios');
      const p = (Array.isArray(predios) ? predios : (predios.predios || []))
        .find((x) => x.org_id === orgId);
      cfg.orgId = orgId;
      cfg.orgNome = (p && p.org_nome) || `Organização ${orgId}`;
      config.setWorkerToken(cfg, r.token);
      config.save(cfg);
      notificarMotorUI();
      return { ok: true, orgNome: cfg.orgNome, keyPrefix: r.key_prefix };
    } catch (e) {
      const msg = e.status === 403
        ? 'Só o dono/admin da organização pode parear o motor local.'
        : e.message;
      return { ok: false, error: `Pareamento falhou: ${msg}` };
    }
  });

  ipcMain.handle('motor-desparear', async () => {
    // Revoga TAMBÉM no servidor (best-effort, com o login do site): só apagar
    // o token local deixaria o offiz_wk_ válido no backend indefinidamente.
    let revogadoNoServidor = false;
    if (cfg.orgId) {
      try {
        const jwt = await lerTokenDoSite();
        if (jwt) {
          await apiV1(cfg.backendUrl, jwt, 'DELETE', `/orgs/${cfg.orgId}/worker-token`);
          revogadoNoServidor = true;
        }
      } catch { /* sem sessão/rede — o dono ainda pode revogar pelo site */ }
    }
    cfg.orgId = null;
    cfg.orgNome = '';
    config.setWorkerToken(cfg, '');
    config.save(cfg);
    notificarMotorUI();
    return {
      ok: true,
      aviso: revogadoNoServidor
        ? null
        : 'Não deu para revogar no servidor (sem login/rede) — revogue em Configurações da organização no site.',
    };
  });

  ipcMain.handle('motor-ligar', () => { worker.start(); return { ok: true }; });
  ipcMain.handle('motor-desligar', async () => { await worker.stop(); return { ok: true }; });

  ipcMain.handle('motor-config-salvar', (_ev, novo) => {
    const siteMudou = novo.siteUrl && novo.siteUrl !== cfg.siteUrl;
    for (const k of ['siteUrl', 'backendUrl', 'claudeBin']) {
      if (typeof novo[k] === 'string') cfg[k] = novo[k].trim();
    }
    config.save(cfg);
    if (siteMudou && siteWin) siteWin.loadURL(cfg.siteUrl);
    return { ok: true };
  });

  // Fluxos do Claude CLI
  ipcMain.handle('claude-conectar', () =>
    claudeManager.loginStart(cfg.claudeBin, (url) => shell.openExternal(url)));
  ipcMain.handle('claude-conectar-aguardar', () => claudeManager.loginWait());
  ipcMain.handle('claude-conectar-cancelar', () => claudeManager.loginCancel());
  ipcMain.handle('claude-relogin-terminal', () => claudeManager.reloginTerminal(cfg.claudeBin));
  ipcMain.handle('claude-setup-token', () => claudeManager.setupTokenTerminal(cfg.claudeBin));
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
    cfg = config.load();
    worker = new MotorWorker({
      getBackendUrl: () => cfg.backendUrl,
      getWorkerToken: () => config.getWorkerToken(cfg),
      getClaudeBin: () => cfg.claudeBin,
      workspacesRoot: path.join(app.getPath('userData'), 'workspaces'),
    });
    worker.on('update', notificarMotorUI);

    montarMenu();
    registrarIpc();
    criarJanelaSite();

    // Primeira execução sem pareamento → já abre o painel do motor.
    if (!config.getWorkerToken(cfg)) abrirJanelaMotor();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) criarJanelaSite();
    });
  });

  app.on('window-all-closed', () => {
    // Fechar tudo encerra o app (inclusive o motor) — comportamento previsível
    // para o leigo; quem quiser o motor sempre vivo deixa a janela aberta.
    app.quit();
  });
}
