// Guard de origem dos handlers IPC do app desktop.
//
// A ponte window.offizMotor fica exposta na janela do SITE — qualquer página
// carregada nela ganharia acesso ao motor (parear, instalar, rodar CLI).
// Este guard garante que só o próprio site (host de cfg.siteUrl) e a janela
// local do motor (file:// do motor.html empacotado) conseguem invocar os
// handlers; navegação inesperada (redirect, página de terceiros) é recusada.
//
// Módulo PURO (sem require de electron) de propósito: dá para smoke-testar
// com `node` cru, fora do Electron.

'use strict';

/**
 * A URL chamadora pode invocar os handlers IPC do motor?
 * - file:   → SÓ o motor.html empacotado (comparação exata, sem query/hash).
 *             Aceitar qualquer file:// permitiria que um .html arrastado para
 *             a janela ganhasse a ponte inteira.
 * - http(s) → precisa bater protocolo E host (host inclui a porta — cobre o
 *             dev em http://localhost:5173) com o siteUrl configurado.
 * Qualquer outra coisa (about:blank, devtools://, string não-parseável) → não.
 *
 * `motorHtmlUrl` é a URL file:// do motor.html do pacote (pathToFileURL no
 * main); sem ela, NENHUM file:// é aceito.
 */
function origemAutorizada(urlChamador, siteUrl, motorHtmlUrl) {
  let chamador;
  try {
    chamador = new URL(String(urlChamador || ''));
  } catch {
    return false; // sem URL válida não há como confiar
  }
  if (chamador.protocol === 'file:') {
    if (!motorHtmlUrl) return false;
    let motor;
    try {
      motor = new URL(String(motorHtmlUrl));
    } catch {
      return false;
    }
    // Compara o caminho exato (case-insensitive: NTFS/APFS), sem query/hash.
    return (
      motor.protocol === 'file:' &&
      chamador.pathname.toLowerCase() === motor.pathname.toLowerCase()
    );
  }

  let site;
  try {
    site = new URL(String(siteUrl || ''));
  } catch {
    return false; // config quebrada → recusa tudo que não for local
  }
  return chamador.protocol === site.protocol && chamador.host === site.host;
}

module.exports = { origemAutorizada };
