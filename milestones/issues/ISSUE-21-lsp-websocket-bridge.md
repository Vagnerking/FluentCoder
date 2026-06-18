# ISSUE-21 · Rust: bridge WebSocket local (127.0.0.1, porta efêmera, token de sessão)

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Rust · **Tamanho:** L · **Depende de:** 20

## Contexto

O `monaco-languageclient` no frontend espera se conectar a um servidor WebSocket que proxy-eia
mensagens JSON-RPC para o Language Server. Esta issue implementa esse bridge no backend Rust:

- Sobe um servidor WS em `127.0.0.1:0` (porta efêmera — sistema operacional escolhe uma livre).
- Autentica a conexão com um token gerado por sessão (evita que outros processos locais se conectem).
- Faz proxy bidirecional: bytes do WS → stdin do LSP; stdout do LSP → WS.
- Expõe um comando Tauri `lsp_bridge_info` para o front descobrir a porta e o token.

A arquitetura isola o transport em `src/lsp/bridge.rs`: se no futuro a porta local for
indesejável, só esse módulo troca — o resto do wiring (ISSUE-23+) não muda.

## Tarefas

- [x] Adicionar `tokio-tungstenite` e `futures-util` ao `Cargo.toml`.
- [x] Criar `src-tauri/src/lsp/bridge.rs`:
      - `pub struct BridgeHandle { port: u16, token: String }`.
      - `pub async fn start_bridge(lsp_process: LspProcess) -> Result<BridgeHandle>`:
        - Bind em `127.0.0.1:0`, ler porta efêmera atribuída.
        - Gerar token aleatório (UUID v4 via `uuid` crate ou `rand` + hex).
        - Spawnar task tokio que aceita **uma** conexão WS, valida o header/query `token`, e
          faz proxy bidirecional com duas tasks: `ws→stdin` e `stdout→ws`.
        - Retornar `BridgeHandle { port, token }`.
- [x] Segurança: rejeitar conexões sem token válido com close code `4401`.
- [x] Bind apenas em `127.0.0.1` — **nunca** `0.0.0.0`.
- [x] Tratar desconexão do WS: encerrar processo LSP graciosamente (`kill` + aguardar).
- [x] Tratar saída do processo LSP: fechar a conexão WS e limpar o estado.
- [x] Implementar comando Tauri `lsp_bridge_info(server_id: String) -> Result<BridgeInfo>` que
      retorna `{ port, token }` para o front usar na conexão WS.
      (O registro no `invoke_handler` é feito na ISSUE-22.)

## Arquivos

- `src-tauri/src/lsp/bridge.rs` (novo)
- `src-tauri/src/lsp/mod.rs` (re-exportar `BridgeHandle`, `start_bridge`)
- `src-tauri/Cargo.toml` (adicionar `tokio-tungstenite`, `futures-util`, `uuid` ou `rand`)

## Detalhes técnicos

- `tokio-tungstenite` é o crate mais leve para WS server local; não precisamos de `warp` ou `axum`.
- O proxy bidirecional usa dois `tokio::spawn`: um lê do WS e escreve no stdin via codec da ISSUE-20;
  o outro lê do stdout via codec e envia como WS text frame.
- O token deve ser transmitido como query param na URL do WS: `ws://127.0.0.1:{port}/?token={token}`.
  O bridge valida antes de completar o handshake.
- Uma conexão por bridge — se o front reconectar, fechar a anterior primeiro.
- Log mínimo: porta alocada, conexão aceita/rejeitada, processo encerrado.

## Critérios de aceite

- [x] Bridge sobe em `127.0.0.1`, nunca em `0.0.0.0`.
- [x] Conexão sem token ou com token errado é rejeitada (close `4401`).
- [x] Proxy bidirecional funciona: mensagem enviada pelo WS chega no stdin do LSP; resposta do stdout do LSP chega no WS.
- [x] Encerrar o processo LSP fecha a conexão WS corretamente.
- [x] Desconectar o WS encerra o processo LSP.
- [x] `cargo check` passa.
