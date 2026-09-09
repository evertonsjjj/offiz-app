# Offiz Standalone — espelho do site com motor local

App desktop (Windows/Mac) que o cliente baixa e instala. A janela principal é o
**próprio site** (offiz.com.br) — toda a engine, dados e UI ficam no servidor,
o app nunca desatualiza. O que o app adiciona é o **motor local**: um worker
que roda as tarefas da organização do cliente **nesta máquina**, com o **Claude
Code CLI dele** (login/assinatura própria) — em `motor_modo = "cli"` o custo
por token **não** entra no ledger do Offiz.

```
Máquina do cliente                          Servidor (Coolify)
┌─────────────────────────────┐            ┌─────────────────────────────┐
│ Offiz Standalone (Electron)  │            │ backend (API + fila + dados)│
│ ├─ Janela = o SITE (espelho) │◀──HTTPS───▶│ ├─ /api/v1 (site + pareamento)
│ └─ Motor local (worker)      │            │ └─ /internal (claim/eventos/ │
│    ├─ claim → workspace.zip  │            │     workspace.zip/upload)    │
│    ├─ Claude Code CLI (login │            └─────────────────────────────┘
│    │   do CLIENTE, skip-perm)│
│    └─ upload outputs+memoria │
└─────────────────────────────┘
```

## Fluxo do cliente (3 passos, tudo no app)

1. **Login no site** — a janela principal É o site; entra com e-mail/senha normais.
2. **Parear** — painel *Motor local* (menu ⚙️ ou `Ctrl+M`) → "Parear com o site".
   O app lê a sessão do site, descobre as organizações do usuário e troca por um
   token de worker escopado (`offiz_wk_…`, guardado cifrado via safeStorage).
   Só **dono/admin** da organização pode parear.
3. **Conectar o Claude** — botão "Conectar Claude": roda `claude auth login
   --claudeai` invisível, captura a URL do OAuth e abre o navegador; o callback
   conclui sozinho (sem colar código). Fallbacks: terminal visível (`wt`/cmd no
   Windows, script `.command` + Terminal.app no Mac) e `claude setup-token`.

Ligou o motor → as tarefas enviadas pelo site (org em `motor_modo = "cli"`)
rodam aqui com `--dangerously-skip-permissions` dentro de um workspace isolado
(`userData/workspaces/org-<id>/<office>/`, limpo a cada job).

## Como o motor executa um job

1. `POST /internal/jobs/claim` (X-Worker-Token da org) — o backend só entrega
   jobs **da organização pareada**; o worker cloud, por sua vez, **pula** orgs
   em modo cli (esses jobs só rodam aqui).
2. `GET /internal/jobs/{id}/workspace.zip` — baixa o workspace inteiro
   (office materializado + entrada/ + clientes + memoria/ + knowledge/).
3. Spawna o `claude` local (stream-json headless, mesmo contrato do worker
   cloud); eventos vão ao vivo para o site via `POST /internal/jobs/{id}/events`.
4. Sobe outputs novos + `memoria/` alterada (`POST /internal/jobs/{id}/upload`).
5. `POST /internal/jobs/{id}/finish` — entregas aparecem no site para aprovação.

## Dev

```powershell
cd webapp/standalone
npm install
# apontando para o ambiente local:
$env:OFFIZ_SITE_URL    = "http://localhost:5173"
$env:OFFIZ_BACKEND_URL = "http://localhost:8100"
npm start
```

Config persistida em `%APPDATA%/offiz-standalone/config.json`
(`~/Library/Application Support/offiz-standalone/` no Mac). As envs acima têm
precedência mas não são gravadas.

## Requisitos do cliente

| Sistema | Mínimo | Desde |
| --- | --- | --- |
| Windows | 10 ou mais novo | sempre |
| macOS | **13 (Ventura)** ou mais novo | **0.2.5** |

O piso do macOS subiu na 0.2.5: o Electron 44 abandonou Big Sur (11) e
Monterey (12) — quem estiver neles fica na
[0.2.4](https://github.com/evertonsjjj/offiz-app/releases/tag/v0.2.4), que
continua publicada. Isso está avisado no topo do `LEIA-ME-MAC.txt`, porque o
sintoma (o app não abre) é o MESMO da quarentena do Gatekeeper e o `xattr` do
manual não conserta este caso — sem o aviso, o cliente diagnostica errado.

## Empacotar

```bash
npm run dist:win   # NSIS one-click + zip (rodar no Windows)
npm run dist:mac   # dmg + zip (PRECISA rodar num Mac)
```

Sem assinatura de código o Windows mostra SmartScreen e o macOS exige
botão-direito → Abrir na primeira vez (ou Apple Developer ID + notarização
para distribuição limpa).

## Segurança

- O token de worker é **escopado à organização** (hash sha256 no banco,
  revogável em Configurações) — não é o token global do cloud.
- O app guarda o token via `safeStorage` (DPAPI/Keychain).
- `--dangerously-skip-permissions` roda **na máquina do cliente, no workspace
  da org dele** — deixe isso explícito no onboarding.
- ToS: modo cli usa a assinatura Claude do próprio cliente nos próprios
  escritórios (análogo BYO-CLI do BYOK). Confirmar a política de uso da
  Anthropic antes de vender isso em escala.


## Os dois motores

O app executa tarefas com **Claude Code** (Anthropic — a assinatura de quem
usa, modo `cli`) e, desde a v0.2.3, com **Codex CLI** (OpenAI — org com
`motor_cli=codex`: a chave DELA direto, sem gateway). Quem decide qual CLI
roda cada job é o backend (`motor_cli` no claim); o worker declara a
capacidade `motor_codex`. Instalação do Codex: `npm install -g
@openai/codex@0.150.0` (pin na versão em que o contrato foi validado —
`src/motor/codex-runtime.js` espelha `webapp/worker/codex_proc.py`; mudou
num lado, muda no outro).
