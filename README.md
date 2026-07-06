# Offiz Desktop — downloads

App desktop do [Offiz](https://offiz.com.br): espelho do site com **motor local** —
rode as tarefas dos seus escritórios no seu computador com o **seu Claude Code CLI**
(assinatura própria, sem custo por token no Offiz).

## Baixar (recomendado: ZIP portátil)

### Windows — [Offiz-win.zip](https://github.com/evertonsjjj/offiz-app/releases/latest/download/Offiz-win.zip)

1. Baixe o `Offiz-win.zip`.
2. **Antes de extrair**: botão direito no zip → **Propriedades** → marque
   **✅ Desbloquear** → OK. *(Isso remove o aviso do Windows de todos os
   arquivos de uma vez — sem ele, o SmartScreen pode bloquear o app.)*
3. Extraia a pasta onde quiser (ex.: `C:\Offiz Desktop`) e abra o **Offiz.exe**.
4. O guia também vai dentro do ZIP: **LEIA-ME.txt**.

> Alternativa com instalador: [Offiz-Setup.exe](https://github.com/evertonsjjj/offiz-app/releases/latest/download/Offiz-Setup.exe)
> — se o SmartScreen bloquear, clique em "Mais informações" → "Executar assim
> mesmo". Se nem essa opção aparecer, use o ZIP acima (com o Desbloquear).

### macOS — [Offiz-mac.zip](https://github.com/evertonsjjj/offiz-app/releases/latest/download/Offiz-mac.zip)

1. Baixe e extraia; arraste o **Offiz.app** para Aplicativos.
2. Na primeira vez, o macOS bloqueia apps não assinados (nas versões novas
   nem o botão-direito → Abrir resolve). Libere com **UMA linha** no Terminal
   (Cmd+Espaço → "Terminal"):

   ```
   xattr -dr com.apple.quarantine /Applications/Offiz.app && open /Applications/Offiz.app
   ```

   *(Isso só remove a marca de quarentena do download — não desativa nenhuma
   proteção do sistema. Das próximas vezes é duplo clique normal.)*
3. O guia completo também vai dentro do ZIP: **LEIA-ME.txt**.

> Alternativa: [Offiz.dmg](https://github.com/evertonsjjj/offiz-app/releases/latest/download/Offiz.dmg)
> (universal, Intel + Apple Silicon) — mesmas instruções de primeira abertura.

## Como usar

1. Abra o app — a janela principal é o próprio site; faça seu login normal
   (qualquer membro da organização pode conectar a própria máquina).
2. Painel **Motor local** (Ctrl+M / Cmd+M): clique **Parear com o site**.
3. Sem o Claude na máquina? Clique **Instalar Claude CLI** (1 clique — usa o
   instalador oficial). Depois, **Conectar Claude** (login da sua assinatura
   via navegador).
4. Se o seu escritório precisar de programas extras (ex.: ffmpeg), a seção
   **Dependências do escritório** mostra o que falta com botão **Instalar**.
5. **Ligar motor** — pronto: as tarefas do seu prédio rodam na sua máquina.

## Build

Os instaladores são gerados pelo [workflow](.github/workflows/build.yml) a cada
tag `v*` (runners Windows e macOS do GitHub Actions). Os avisos de primeira
execução somem quando houver assinatura de código (certificado Windows +
Apple Developer ID); o CI já está pronto para recebê-los.
