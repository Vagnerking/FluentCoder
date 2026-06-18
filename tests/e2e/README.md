# Testes E2E (Tauri + WebDriver)

Testes end-to-end que dirigem o **app Tauri nativo** via
[`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/) +
[WebdriverIO](https://webdriver.io).

> ⚠️ Isto **não** é Playwright nem um MCP server. O Tauri testa o app
> desktop pelo protocolo WebDriver (no Windows, via Edge WebView2 Driver).
> Não existe um "Playwright MCP do Tauri".

## Pré-requisitos (Windows)

Já instalados nesta máquina (`~\.cargo\bin`), mas para referência:

```powershell
# Driver de WebDriver do Tauri
cargo install tauri-driver --locked

# Edge WebView2 Driver (msedgedriver) — deve casar com a versão do Edge/WebView2
# https://developer.microsoft.com/microsoft-edge/tools/webdriver/
```

`tauri-driver` e `msedgedriver` precisam estar no `PATH`.

## Rodando

```powershell
cd tests/e2e
npm install
npm run test:e2e
```

O `onPrepare` do [wdio.conf.ts](wdio.conf.ts) compila o app com
`npx tauri build --no-bundle` antes da suíte, e cada sessão sobe/derruba o
`tauri-driver` automaticamente.

> ⚠️ **Tem que ser `tauri build`, não `cargo build --release`.** Só a CLI do
> Tauri compila o binário em modo produção (que serve os assets embutidos de
> `dist/`). Um `cargo build` direto gera um binário que ainda aponta para o
> `devUrl` (`localhost:1420`); como não há dev server rodando nos testes, a
> WebView abre em "localhost refused to connect" e nenhum seletor é encontrado.
> `--no-bundle` pula a geração de instaladores (.msi/.exe) — bem mais rápido.

## Estrutura

- [wdio.conf.ts](wdio.conf.ts) — configuração do WebdriverIO + lifecycle do tauri-driver
- [specs/](specs/) — arquivos de teste (`*.e2e.ts`)
- [tsconfig.json](tsconfig.json) — TS isolado da suíte E2E

## Notas

- O binário esperado é `src-tauri/target/release/code-editor.exe`. Se o
  nome do produto mudar no `tauri.conf.json`, ajuste `appBinary` no
  `wdio.conf.ts`.
- WebView2 (Chromium) é o engine no Windows, então seletores CSS/DOM
  funcionam normalmente.
