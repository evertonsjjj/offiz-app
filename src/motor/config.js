// Config persistente do app standalone — userData/config.json.
//
// O token de worker (pareamento com a organização) é o único segredo: vai
// cifrado com safeStorage (DPAPI no Windows, Keychain no Mac). Se o SO não
// tiver cofre disponível (Linux sem gnome-keyring, etc.), cai em plaintext
// com um aviso — melhor que quebrar o app.

'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  // Espelho do site: toda a UI/engine vem daqui. Em dev aponte para o Vite
  // (http://localhost:5173) via env OFFIZ_SITE_URL ou editando o config.json.
  siteUrl: 'https://offiz.com.br',
  // API do backend hospedado (rotas /api/v1 e /internal).
  backendUrl: 'https://api.offiz.com.br',
  // Organização pareada (o motor local só reivindica jobs dela).
  orgId: null,
  orgNome: '',
  // Token de worker cifrado (base64 do safeStorage) OU plaintext se o SO não
  // tiver cofre ('plain:' prefixado para distinguir).
  workerTokenEnc: '',
  // Override manual do binário do claude (vazio = auto-detecção).
  claudeBin: '',
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    /* primeira execução ou JSON corrompido — usa defaults */
  }
  const cfg = { ...DEFAULTS, ...raw };
  // Env vars têm precedência (dev/testes) mas NÃO são persistidas.
  if (process.env.OFFIZ_SITE_URL) cfg.siteUrl = process.env.OFFIZ_SITE_URL;
  if (process.env.OFFIZ_BACKEND_URL) cfg.backendUrl = process.env.OFFIZ_BACKEND_URL;
  return cfg;
}

function save(cfg) {
  const persist = {};
  for (const k of Object.keys(DEFAULTS)) persist[k] = cfg[k];
  const destino = configPath();
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  // Escrita atômica (tmp + rename): um crash no meio do write deixaria um
  // JSON truncado — e o load() cairia nos defaults, perdendo o pareamento.
  const tmp = destino + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(persist, null, 2), 'utf-8');
  fs.renameSync(tmp, destino);
}

function setWorkerToken(cfg, token) {
  if (!token) {
    cfg.workerTokenEnc = '';
    return cfg;
  }
  if (safeStorage.isEncryptionAvailable()) {
    cfg.workerTokenEnc = safeStorage.encryptString(token).toString('base64');
  } else {
    cfg.workerTokenEnc = 'plain:' + Buffer.from(token, 'utf-8').toString('base64');
  }
  return cfg;
}

function getWorkerToken(cfg) {
  const enc = cfg.workerTokenEnc || '';
  if (!enc) return '';
  try {
    if (enc.startsWith('plain:')) {
      return Buffer.from(enc.slice(6), 'base64').toString('utf-8');
    }
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return ''; // cofre trocou (outro usuário/SO) — exige re-pareamento
  }
}

module.exports = { load, save, setWorkerToken, getWorkerToken, configPath };
