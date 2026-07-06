// Bridge do painel do motor (contextIsolation) — só o que a UI usa.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('offizMotor', {
  estado: () => ipcRenderer.invoke('motor-estado'),
  claudeStatus: () => ipcRenderer.invoke('claude-status'),
  orgs: () => ipcRenderer.invoke('motor-orgs'),
  parear: (orgId) => ipcRenderer.invoke('motor-parear', orgId),
  desparear: () => ipcRenderer.invoke('motor-desparear'),
  ligar: () => ipcRenderer.invoke('motor-ligar'),
  desligar: () => ipcRenderer.invoke('motor-desligar'),
  salvarConfig: (cfg) => ipcRenderer.invoke('motor-config-salvar', cfg),
  conectarClaude: () => ipcRenderer.invoke('claude-conectar'),
  aguardarLoginClaude: () => ipcRenderer.invoke('claude-conectar-aguardar'),
  cancelarLoginClaude: () => ipcRenderer.invoke('claude-conectar-cancelar'),
  reloginTerminal: () => ipcRenderer.invoke('claude-relogin-terminal'),
  setupToken: () => ipcRenderer.invoke('claude-setup-token'),
  onUpdate: (cb) => {
    ipcRenderer.on('motor-update', () => cb());
  },
});
