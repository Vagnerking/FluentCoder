# ISSUE-20 · Rust: spawn de processo LSP + codec Content-Length

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Rust · **Tamanho:** M · **Depende de:** 19

## Contexto

Para se comunicar com qualquer servidor LSP (Roslyn, rzls, typescript-language-server), o backend
Rust precisa de duas capacidades básicas:

1. **Spawnar um processo filho** com `stdin`/`stdout`/`stderr` capturáveis — semelhante ao PTY em
   [terminal.rs](../../src-tauri/src/terminal.rs), mas usando `std::process::Command` (não PTY).
2. **Codec LSP (Content-Length):** o protocolo LSP usa framing
   `Content-Length: N\r\n\r\n<json>` sobre stdio. É necessário um codec que saiba ler frames
   completos e escrever frames formatados — sem dependência de crates LSP pesadas.

Esta issue implementa essas duas peças de forma **genérica e server-agnostic**, reutilizável por
todos os servidores (C#, Razor, TypeScript).

## Tarefas

- [x] Criar módulo `src-tauri/src/lsp/mod.rs` (vazio por ora, re-exporta submódulos).
- [x] Criar `src-tauri/src/lsp/process.rs`:
      - Struct `LspProcess { stdin: ChildStdin, stdout: BufReader<ChildStdout>, stderr: ChildStderr, child: Child }`.
      - Função `LspProcess::spawn(program: &str, args: &[&str], cwd: &Path, env: &[(&str, &str)]) -> Result<LspProcess>`.
      - Usar `tokio::process::Command` com `stdin(Stdio::piped())`, `stdout(Stdio::piped())`, `stderr(Stdio::piped())`.
- [x] Criar `src-tauri/src/lsp/codec.rs`:
      - Função assíncrona `read_message(reader: &mut impl AsyncBufRead) -> Result<String>`:
        lê `Content-Length: N`, pula `\r\n`, lê exatamente N bytes UTF-8.
      - Função assíncrona `write_message(writer: &mut impl AsyncWrite, json: &str) -> Result<()>`:
        escreve `Content-Length: {len}\r\n\r\n{json}`.
- [x] Adicionar `tokio` ao `Cargo.toml` com features `rt-multi-thread`, `macros`, `io-util`, `process`.
- [x] Adicionar `mod lsp;` em `lib.rs` (sem registrar comandos ainda — isso é ISSUE-22).
- [x] Escrever teste unitário básico do codec (round-trip: escreve → lê → compara JSON).

## Arquivos

- `src-tauri/src/lsp/mod.rs` (novo)
- `src-tauri/src/lsp/process.rs` (novo)
- `src-tauri/src/lsp/codec.rs` (novo)
- `src-tauri/src/lib.rs` (adicionar `mod lsp;`)
- `src-tauri/Cargo.toml` (adicionar `tokio`)

## Detalhes técnicos

- **Não usar** `portable-pty` aqui — LSP usa stdio normal, não PTY.
- **tokio restrito ao módulo `lsp/`**: não tocar `terminal.rs` (síncrono com `std::thread`).
- Padrão de referência do processo de longa duração: [terminal.rs](../../src-tauri/src/terminal.rs)
  (Mutex + thread de leitura + emit). A diferença é que aqui usamos `tokio::process` + tasks assíncronas.
- O codec é deliberadamente simples (sem crate `lsp-server`/`async-lsp`) para manter a dependência mínima.
- `stderr` do servidor LSP deve ser redirecionado para log do Tauri com prefixo do server id.

## Critérios de aceite

- [x] `cargo check` passa sem erros no módulo `lsp`.
- [x] Teste unitário do codec: round-trip de mensagem JSON-RPC passa.
- [x] `LspProcess::spawn` retorna processo vivo com stdin/stdout capturáveis.
- [x] stderr do servidor aparece no log do Tauri (não é silenciado).
- [x] Nenhuma alteração em `terminal.rs` ou outros módulos existentes.
