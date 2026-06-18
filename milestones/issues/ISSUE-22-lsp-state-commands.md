# ISSUE-22 · Rust: LspState + comandos Tauri + registro em lib.rs

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Rust · **Tamanho:** M · **Depende de:** 20, 21

## Contexto

Com o spawn de processo (ISSUE-20) e o bridge WS (ISSUE-21) prontos, esta issue monta a camada de
gerenciamento de estado e os comandos Tauri que o front usa para controlar os servidores LSP.

O padrão espelha exatamente o `TerminalState` de [terminal.rs](../../src-tauri/src/terminal.rs):
um `Mutex<HashMap<String, LspServerSession>>` que guarda uma sessão por `server_id`, e comandos
`lsp_start_server` / `lsp_stop_server` / `lsp_bridge_info`.

## Tarefas

- [x] Em `src-tauri/src/lsp/mod.rs`, definir:
      ```rust
      pub struct LspServerSession {
          bridge: BridgeHandle,
          // handle para aguardar o processo se necessário
      }
      pub struct LspState {
          sessions: Mutex<HashMap<String, LspServerSession>>,
      }
      impl LspState { pub fn new() -> Self { ... } }
      ```
- [x] Implementar comando `lsp_start_server(id: String, program: String, args: Vec<String>, cwd: String) -> Result<BridgeInfo>`:
      - Spawna `LspProcess` com os parâmetros dados.
      - Sobe `Bridge` via `start_bridge(process)`.
      - Armazena a sessão em `LspState`.
      - Retorna `{ port, token }`.
- [x] Implementar comando `lsp_stop_server(id: String) -> Result<()>`:
      - Remove a sessão do HashMap.
      - Encerra o processo LSP graciosamente.
- [x] Implementar comando `lsp_bridge_info(id: String) -> Result<BridgeInfo>`:
      - Retorna `{ port, token }` de uma sessão existente (útil para reconexão do front).
- [x] Em `lib.rs`:
      - Adicionar `mod lsp;`.
      - Adicionar `.manage(lsp::LspState::new())` no builder.
      - Registrar `lsp_start_server`, `lsp_stop_server`, `lsp_bridge_info` no `generate_handler!`.
- [x] Em `src/api.ts`, adicionar as funções de invocação correspondentes:
      `startLspServer`, `stopLspServer`, `lspBridgeInfo`.

## Arquivos

- `src-tauri/src/lsp/mod.rs` (implementar `LspState`, `LspServerSession`, comandos)
- `src-tauri/src/lib.rs` (registrar mod + manage + handlers)
- `src/api.ts` (adicionar funções de IPC para os novos comandos)

## Detalhes técnicos

- O `id` da sessão é uma string livre escolhida pelo front (ex: `"csharp"`, `"typescript"`, `"razor"`).
- `BridgeInfo` é serializado via Serde: `{ port: u16, token: String }`.
- `lsp_start_server` recebe o caminho do executável já resolvido pelo código de aquisição do servidor
  (ISSUE-26 para C#, ISSUE-34 para TS). Esta issue é agnóstica ao servidor.
- Se um servidor com o mesmo `id` já estiver rodando, `lsp_start_server` deve encerrar o anterior
  antes de subir o novo (evitar instâncias duplicadas).
- O tokio runtime do módulo LSP deve ser criado com `tokio::runtime::Runtime::new()` no `LspState::new()`
  ou via `#[tokio::main]` em um thread dedicado — avaliar a abordagem menos invasiva para o
  backend Tauri (que é síncrono por padrão).

## Critérios de aceite

- [x] `cargo check` passa com os novos comandos registrados.
- [x] `lsp_start_server` retorna `{ port, token }` funcionais.
- [x] `lsp_stop_server` encerra o processo sem panic.
- [x] `lsp_bridge_info` retorna os dados de uma sessão ativa.
- [x] `src/api.ts` exporta as três funções de invocação com tipos corretos.
- [x] Nenhuma regressão nos comandos existentes (`term_create`, `read_file` etc.).
