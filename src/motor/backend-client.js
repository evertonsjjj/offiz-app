// HTTP do motor local ↔ backend hospedado.
//
// Dois planos de auth:
// - Bearer (JWT do usuário, lido do webview do site) → rotas /api/v1 (pareamento).
// - X-Worker-Token (token offiz_wk_... da org) → rotas /internal (claim, eventos,
//   workspace.zip, upload, finish).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function _base(url) {
  return String(url || '').replace(/\/+$/, '');
}

// Timeouts explícitos: sem AbortSignal o undici só desiste em ~300s — uma
// conexão muda penduraria claim/heartbeat (e a detecção de cancelamento).
const TIMEOUT_JSON_MS = 20000;
const TIMEOUT_ZIP_MS = 180000;   // workspace grande demora — mas não para sempre
const TIMEOUT_UPLOAD_MS = 120000;

/** Chamada JSON às rotas /api/v1 com o JWT do usuário. */
async function apiV1(backendUrl, token, method, apiPath, body) {
  const resp = await fetch(`${_base(backendUrl)}/api/v1${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_JSON_MS),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const detail = data && data.detail ? String(data.detail) : `HTTP ${resp.status}`;
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }
  return data;
}

/** Chamada JSON às rotas /internal com o token de worker da org. */
async function internal(backendUrl, workerToken, method, internalPath, body) {
  const resp = await fetch(`${_base(backendUrl)}/internal${internalPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Worker-Token': workerToken },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_JSON_MS),
  });
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const detail = data && data.detail ? String(data.detail) : `HTTP ${resp.status}`;
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }
  return data;
}

/** Baixa o workspace.zip do job para `destino` (arquivo local). */
async function baixarWorkspaceZip(backendUrl, workerToken, jobId, destino) {
  const resp = await fetch(`${_base(backendUrl)}/internal/jobs/${jobId}/workspace.zip`, {
    headers: { 'X-Worker-Token': workerToken },
    signal: AbortSignal.timeout(TIMEOUT_ZIP_MS),
  });
  if (!resp.ok) {
    const err = new Error(`Download do workspace falhou (HTTP ${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, buf);
  return destino;
}

/**
 * Sobe um arquivo do workspace local de volta ao servidor
 * (POST /internal/jobs/{id}/upload, multipart com caminho_rel).
 * Multipart montado à mão (Buffer) — sem dependências.
 */
async function uploadArquivo(backendUrl, workerToken, jobId, caminhoRel, arquivoLocal) {
  const boundary = '----offiz' + crypto.randomBytes(12).toString('hex');
  const conteudo = fs.readFileSync(arquivoLocal);
  const nome = path.basename(arquivoLocal);

  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="caminho_rel"\r\n\r\n` +
    `${caminhoRel}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="arquivo"; filename="${nome.replace(/"/g, '_')}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(head, 'utf-8'), conteudo, Buffer.from(tail, 'utf-8')]);

  const resp = await fetch(`${_base(backendUrl)}/internal/jobs/${jobId}/upload`, {
    method: 'POST',
    headers: {
      'X-Worker-Token': workerToken,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_UPLOAD_MS),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const detail = data && data.detail ? String(data.detail) : `HTTP ${resp.status}`;
    throw new Error(`Upload de ${caminhoRel} falhou: ${detail}`);
  }
  return data;
}

module.exports = { apiV1, internal, baixarWorkspaceZip, uploadArquivo };
