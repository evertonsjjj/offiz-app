// Ponte do SITE (janela principal) com o motor local — janela única.
//
// Exposta via contextBridge só no app desktop; o site faz feature-detect de
// window.offizMotor para renderizar o painel do motor embutido na própria
// página (adeus janela separada). Nada de ipcRenderer cru no mundo da página:
// cada método é uma função fechada sobre canais fixos, e os "on*" devolvem
// unsubscribe de verdade (removeListener).

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Versão do app: o main injeta via additionalArguments (--offiz-versao=x.y.z)
// — chega no process.argv do preload mesmo com sandbox, sem IPC síncrono.
const VERSAO = (() => {
  const prefixo = '--offiz-versao=';
  const arg = (process.argv || []).find(
    (a) => typeof a === 'string' && a.startsWith(prefixo)
  );
  return arg ? arg.slice(prefixo.length) : '';
})();

// Assina um canal e devolve o unsubscribe correspondente. O listener embrulha
// o callback da página: ela nunca vê o objeto `event` do Electron.
function assinar(canal, cb) {
  const listener = (_ev, ...args) => {
    try { cb(...args); } catch { /* página descartou o callback */ }
  };
  ipcRenderer.on(canal, listener);
  return () => ipcRenderer.removeListener(canal, listener);
}

contextBridge.exposeInMainWorld('offizMotor', {
  versao: VERSAO,

  // Estado consolidado (config + pareamento + worker). O main guarda
  // pareadoPor dentro de config; o contrato do site o quer no topo.
  estado: async () => {
    const r = await ipcRenderer.invoke('motor-estado');
    if (!r || !r.config) return r; // guard de origem recusou ({ok:false,…})
    const { pareadoPor, ...config } = r.config;
    return {
      config,
      pareado: Boolean(r.pareado),
      pareadoPor: pareadoPor || null,
      worker: r.worker,
    };
  },

  // Estado do Claude (spawnSync no main, até ~10s) — chamar sob demanda.
  claudeStatus: () => ipcRenderer.invoke('claude-status'),

  // Pareamento com a organização. O main devolve também motorTrocado/avisoModo
  // (troca automática do motor da org para 'cli' quando a dupla se completa).
  parear: (orgId) => ipcRenderer.invoke('motor-parear', Number(orgId)),
  desparear: () => ipcRenderer.invoke('motor-desparear'),

  ligar: () => ipcRenderer.invoke('motor-ligar'),
  desligar: () => ipcRenderer.invoke('motor-desligar'),

  // Login do Claude: conectar abre o OAuth no navegador padrão; aguardar
  // resolve quando o callback web conclui (e devolve motorTrocado/avisoModo).
  conectarClaude: () => ipcRenderer.invoke('claude-conectar'),
  aguardarLoginClaude: () => ipcRenderer.invoke('claude-conectar-aguardar'),
  cancelarLoginClaude: () => ipcRenderer.invoke('claude-conectar-cancelar'),

  // Instalação do Claude CLI com 1 clique (log ao vivo em onInstalarLinha).
  instalarClaude: () => ipcRenderer.invoke('claude-instalar'),

  // Dependências do escritório (whitelist fixa no main — nome vindo do
  // servidor nunca vira execução).
  verificarDeps: async () => {
    const r = await ipcRenderer.invoke('deps-status');
    return Array.isArray(r) ? { deps: r } : r; // guard recusou → repassa o erro
  },
  instalarDep: (nome) => ipcRenderer.invoke('deps-instalar', String(nome)),

  // Push do main a cada mudança do motor. Devolve unsubscribe de verdade.
  onUpdate: (cb) => {
    if (typeof cb !== 'function') return () => {};
    return assinar('motor-update', () => cb());
  },

  // Stream ao vivo das instalações (Claude CLI e dependências num só fluxo).
  onInstalarLinha: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const offClaude = assinar('claude-instalar-log', (linha) => cb(String(linha)));
    const offDeps = assinar('deps-instalar-log', (linha) => cb(String(linha)));
    return () => { offClaude(); offDeps(); };
  },
});

// Feature-detect leve: o site sabe que roda dentro do desktop (e qual versão
// da casca) sem precisar chamar nada.
contextBridge.exposeInMainWorld('offizDesktop', { versao: VERSAO });
