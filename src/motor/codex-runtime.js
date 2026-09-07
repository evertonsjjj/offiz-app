// Spawn do CODEX CLI (OpenAI) headless + tradução do stream JSONL.
//
// IRMÃO de claude-runtime.js e PORTA de webapp/worker/codex_proc.py — o
// contrato da casa é que os três mudam JUNTOS. Quem escolhe entre Claude e
// Codex é o worker, pelo campo `motor_cli` do claim; aqui só se obedece.
//
// POR QUE ELE EXISTE no app: uma org de OpenAI com motor_cli=codex roda a
// chave DELA direto, sem gateway. O claim traz a chave (modo api); o env do
// spawn remove TODA credencial da máquina antes — o custo é sempre da org.
//
// O QUE MUDA em relação ao Claude Code (validado nos binários 0.149.0 e
// 0.150.0 — flags conferidas uma a uma em 26/08/2026, --search segue rejeitado):
// - comando: `codex exec` com `-` (prompt via stdin);
// - eventos: JSONL `thread.*`/`turn.*`/`item.*` → CodexJsonParser traduz
//   para os cinco eventos do Offiz;
// - sessão: o Codex NÃO aceita --session-id (devolve o dele no
//   thread.started — só anotado);
// - permissões/REDE: --dangerously-bypass-approvals-and-sandbox (no sandbox
//   padrão a rede fica BLOQUEADA e metade das skills morre);
// - busca: `-c web_search=live` (a flag --search NÃO existe no exec e mata o
//   spawn);
// - a lei do office inteira: `-c project_doc_max_bytes=262144` (o padrão de
//   32 KiB parava de ler antes dos portões finais);
// - subagentes: `-c features.multi_agent_v2=true` solta o freio de fábrica;
// - esforço: `-c model_reasoning_effort=...` (não é flag);
// - custo: o Codex reporta TOKENS; custo 0 faz o backend estimar por tabela.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// A normalização da declaração de MCP mora no irmão (mesmo arranjo do lado
// Python, onde codex_proc.py importa de claude_proc.py): os dois motores
// recebem a MESMA declaração do claim e precisam recusar exatamente as mesmas
// entradas — validação copiada é validação que diverge no primeiro conserto.
const { normalizarMcpServers } = require('./claude-runtime');

const RESUMO_MAX = 200;
const TETO_AGENTS_MD = 262144;
const EFFORTS_CODEX = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Mesmos nomes de ferramenta do Claude Code de propósito: o log de agente do
// site traduz ESSES para português de leigo (log-agente.ts).
const FERRAMENTA_POR_ITEM = {
  command_execution: 'Bash',
  file_change: 'Write',
  web_search: 'WebSearch',
  mcp_tool_call: 'Task',
  todo_list: 'TodoWrite',
};

function _existe(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function resolveCodexCmd(codexBin) {
  const binario = codexBin || process.env.CODEX_BIN || 'codex';
  if (process.platform !== 'win32') return [binario];
  // O `where` devolve DUAS entradas para um pacote npm no Windows: o shim SEM
  // extensao (script sh, que o CreateProcess NAO executa) e o `.cmd`. Pegar a
  // primeira derrubava TODA tarefa de org Codex na maquina do dono, com
  // `spawn ...\npm\codex ENOENT` — flagrado ao vivo em 30/08/2026, com o job
  // ja claimado e o workspace ja baixado. O claude-runtime filtra por extensao
  // executavel desde sempre; este arquivo e irmao dele e tinha ficado para tras.
  let alvo = _existe(binario) ? binario : '';
  if (!alvo) {
    // (`where` so aceita NOME, nao caminho: com um caminho ele erra, a lista
    // vem vazia e a busca cai no proprio `binario` — que e o desejado.)
    const r = spawnSync('where.exe', [binario], { encoding: 'utf-8', windowsHide: true });
    const achados = (r.stdout || '')
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .filter((c) => /\.(exe|cmd|bat)$/i.test(c));
    // .exe primeiro: dispensa o shell.
    const ordenados = achados
      .filter((c) => /\.exe$/i.test(c))
      .concat(achados.filter((c) => !/\.exe$/i.test(c)));
    alvo = ordenados.find(_existe) || binario;
  }
  if (/\.(cmd|bat)$/i.test(alvo)) return [process.env.COMSPEC || 'cmd.exe', '/c', alvo];
  return [alvo];
}

/** Pares `-c` dos servidores MCP declarados pelo escritório.
 *
 *  O Codex não tem arquivo de config por job como o Claude: servidor de MCP
 *  entra pela MESMA porta `-c` das outras opções (`mcp_servers.<nome>.…`), e
 *  o valor é lido como TOML — JSON.stringify já produz a string entre aspas e
 *  a lista no formato que ele aceita.
 *
 *  O que NÃO entra aqui: valor de segredo. Servidor http autentica por
 *  `bearer_token_env_var` (o NOME da variável; quem resolve é o CLI, lendo o
 *  env do processo), e o stdio recebe o env pela herança do spawn. Um token em
 *  argv apareceria em qualquer `ps`/Gerenciador de Tarefas da máquina do
 *  cliente — e o argv também vai parar em log de erro. */
function mcpArgsDoCodex(decl, avisar) {
  const pares = [];
  for (const s of normalizarMcpServers(decl, avisar)) {
    const base = `mcp_servers.${s.nome}`;
    if (s.url) {
      pares.push('-c', `${base}.url=${JSON.stringify(s.url)}`);
      if (s.bearerTokenEnvVar) {
        pares.push('-c', `${base}.bearer_token_env_var=${JSON.stringify(s.bearerTokenEnvVar)}`);
      }
    } else {
      pares.push('-c', `${base}.command=${JSON.stringify(s.command)}`);
      if (s.args.length) pares.push('-c', `${base}.args=${JSON.stringify(s.args)}`);
    }
  }
  return pares;
}

function buildCodexArgs(model, effort, mcpServers) {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c', 'web_search=live',
    '-c', `project_doc_max_bytes=${TETO_AGENTS_MD}`,
    '-c', 'features.multi_agent_v2=true',
  ];
  const eff = String(effort || '').trim().toLowerCase();
  if (EFFORTS_CODEX.has(eff)) args.push('-c', `model_reasoning_effort=${eff}`);
  // Sem declaração (ou com tudo inválido) a lista vem vazia e o argv fica
  // idêntico ao de antes — escritório que não pede MCP não muda de comando.
  args.push(...mcpArgsDoCodex(mcpServers));
  if (model) args.push('--model', model);
  args.push('-'); // prompt via stdin: acentos no Windows + tamanho de linha
  return args;
}

// ESPELHO de build_codex_env (webapp/worker/codex_proc.py): remove TODA
// credencial de modelo da máquina e os segredos do worker; injeta só a chave
// da organização (o claim manda — modo api, sem gateway).
function buildCodexEnv(openaiApiKey, extraEnv) {
  const env = { ...process.env };
  for (const k of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
    'WORKER_TOKEN', 'BACKEND_URL',
  ]) delete env[k];
  if (openaiApiKey) {
    // As duas: o CLI lê CODEX_API_KEY; scripts dos offices esperam OPENAI_API_KEY.
    env.CODEX_API_KEY = openaiApiKey;
    env.OPENAI_API_KEY = openaiApiKey;
  }
  for (const [chave, valor] of Object.entries(extraEnv || {})) {
    const alto = String(chave).toUpperCase();
    if (alto.startsWith('ANTHROPIC_') || alto.startsWith('CLAUDE_')
      || alto.startsWith('OPENAI_') || alto.startsWith('CODEX_')
      || alto === 'WORKER_TOKEN' || alto === 'BACKEND_URL') continue;
    env[String(chave)] = String(valor);
  }
  env.PYTHONIOENCODING = 'utf-8';
  // PYTHONUTF8=1: os scripts do escritório rodam ffmpeg com text=True e, no
  // Windows, decodificam pela locale (cp1252) — um acento derruba a leitura.
  // Mesma linha do worker/claude_proc.py (05/09/2026).
  env.PYTHONUTF8 = '1';
  return env;
}

function spawnCodex({ workspaceDir, prompt, model, effort, openaiApiKey, extraEnv, codexBin, mcpServers }) {
  const cmd = resolveCodexCmd(codexBin);
  const args = cmd.slice(1).concat(buildCodexArgs(model, effort, mcpServers));
  const proc = spawn(cmd[0], args, {
    cwd: workspaceDir,
    env: buildCodexEnv(openaiApiKey, extraEnv),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  });
  try {
    proc.stdin.write(prompt.endsWith('\n') ? prompt : prompt + '\n');
    proc.stdin.end();
  } catch { /* o close do processo conta a história */ }
  return proc;
}

/** Parser incremental do `codex exec --json` → eventos do Offiz.
 *  MESMA FACE do StreamJsonParser (feed/close devolvem arrays; resultInfo em
 *  camelCase é o que o worker lê para o finish). */
class CodexJsonParser {
  constructor() {
    this._buf = '';
    this.threadId = null;   // sessão DO CODEX (anotada; a chave do Offiz é outra)
    this.erro = null;
    this.resultInfo = null;
  }

  feed(data) {
    const out = [];
    this._buf += data;
    let lf;
    while ((lf = this._buf.indexOf('\n')) >= 0) {
      const linha = this._buf.slice(0, lf);
      this._buf = this._buf.slice(lf + 1);
      out.push(...this._linha(linha));
    }
    return out;
  }

  close() {
    const resto = this._buf;
    this._buf = '';
    return this._linha(resto);
  }

  _linha(linha) {
    const t = String(linha || '').trim();
    if (!t) return [];
    let ev;
    try { ev = JSON.parse(t); } catch { return []; } // log intercalado: ignora
    if (!ev || typeof ev !== 'object') return [];
    const tipo = ev.type;

    if (tipo === 'thread.started') {
      if (typeof ev.thread_id === 'string') this.threadId = ev.thread_id;
      return [];
    }
    if (tipo === 'item.started' || tipo === 'item.completed') {
      return this._item(tipo, ev.item || {});
    }
    if (tipo === 'turn.completed') {
      const uso = ev.usage || {};
      // Cache é SUBCONJUNTO da entrada (convenção OpenAI): somar contaria
      // duas vezes — a lição de US$34 num dia de US$5.
      const entrada = Number(uso.input_tokens) || 0;
      const cache = Math.min(Number(uso.cached_input_tokens) || 0, entrada);
      const saida = (Number(uso.output_tokens) || 0)
        + (Number(uso.reasoning_output_tokens) || 0);
      this.resultInfo = {
        tokens_entrada: entrada,
        tokens_cache: cache,
        tokens_saida: saida,
        custo_brl: 0.0, // o backend estima pela tabela (mesmo caminho do fake)
        duracao_ms: 0,
        is_error: false,
      };
      return [{ tipo: 'resultado', payload: { ...this.resultInfo } }];
    }
    if (tipo === 'turn.failed' || tipo === 'error') {
      let msg = ev.message || ev.error || 'Falha no motor Codex';
      if (msg && typeof msg === 'object') msg = msg.message || JSON.stringify(msg);
      this.erro = String(msg).slice(0, 500);
      const base = this.resultInfo || {
        tokens_entrada: 0, tokens_saida: 0, custo_brl: 0.0, duracao_ms: 0,
      };
      this.resultInfo = { ...base, is_error: true, erro: this.erro };
      return [{ tipo: 'erro', payload: { mensagem: this.erro } }];
    }
    return [];
  }

  _item(tipoEv, item) {
    if (!item || typeof item !== 'object') return [];
    const itemTipo = String(item.item_type || item.type || '');

    // Texto do agente só no completed (no started vem vazio/parcial).
    if (itemTipo === 'agent_message') {
      if (tipoEv !== 'item.completed') return [];
      const texto = item.text || item.message || '';
      if (typeof texto === 'string' && texto.trim()) {
        return [{ tipo: 'agent_text', payload: { texto } }];
      }
      return [];
    }

    // Ferramentas só no started: é o "está fazendo agora" da tela.
    if (tipoEv !== 'item.started') return [];
    const ferramenta = FERRAMENTA_POR_ITEM[itemTipo];
    if (!ferramenta) {
      // Itens de delegação do multi_agent_v2 acendem a faixa de SUBAGENTE.
      if (itemTipo.includes('agent')) {
        let nome = '';
        for (const chave of ['name', 'agent', 'role', 'agent_name', 'title']) {
          const v = item[chave];
          if (typeof v === 'string' && v.trim()) { nome = v.trim().slice(0, RESUMO_MAX); break; }
        }
        return [{ tipo: 'subagente', payload: { nome: nome || itemTipo, acao: 'start' } }];
      }
      return []; // reasoning e tipos desconhecidos não viram evento
    }
    let resumo = '';
    for (const chave of ['command', 'path', 'file', 'query', 'tool', 'server', 'title']) {
      const v = item[chave];
      if (typeof v === 'string' && v.trim()) { resumo = v.trim().slice(0, RESUMO_MAX); break; }
    }
    if (!resumo && Array.isArray(item.changes) && item.changes[0]
      && typeof item.changes[0] === 'object') {
      resumo = String(item.changes[0].path || '').slice(0, RESUMO_MAX);
    }
    return [{ tipo: 'tool_use', payload: { ferramenta, resumo } }];
  }
}

module.exports = {
  spawnCodex, CodexJsonParser, buildCodexArgs, buildCodexEnv, resolveCodexCmd, mcpArgsDoCodex,
};
