# Offiz Desktop — downloads

App desktop do [Offiz](https://offiz.com.br): espelho do site com **motor local** —
rode as tarefas dos seus escritórios no seu computador com o **seu Claude Code CLI**
(assinatura própria, sem custo por token no Offiz).

## Baixar

- **Windows**: [Offiz-Setup.exe](https://github.com/evertonsjjj/offiz-app/releases/latest/download/Offiz-Setup.exe)
- **macOS** (Intel e Apple Silicon): [Offiz.dmg](https://github.com/evertonsjjj/offiz-app/releases/latest/download/Offiz.dmg)

## Como usar

1. Instale e abra — a janela principal é o próprio site; faça seu login normal.
2. Painel **Motor local** (Ctrl+M / Cmd+M): clique **Parear com o site**.
3. Clique **Conectar Claude** (usa sua assinatura Claude via navegador).
4. **Ligar motor** — pronto: as tarefas do seu prédio rodam na sua máquina.

## Avisos de primeira execução (instaladores ainda não assinados)

- **Windows** (SmartScreen): "Mais informações" → "Executar assim mesmo".
- **macOS** (Gatekeeper): botão direito no app → **Abrir** → Abrir. Se o macOS
  bloquear o .dmg: Ajustes → Privacidade e Segurança → "Abrir assim mesmo".

## Build

Os instaladores são gerados pelo [workflow](.github/workflows/build.yml) a cada
tag `v*` (runners Windows e macOS do GitHub Actions). O código-fonte aqui é o
espelho de distribuição do app; o desenvolvimento acontece no repositório
principal do Offiz.
