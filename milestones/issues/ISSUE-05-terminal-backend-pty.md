# ISSUE-05 · Backend do terminal (PTY no Rust)

**Épico:** [Fluent VSCode Layout](../EPIC-fluent-vscode-layout.md) · **Camada:** Rust · **Tamanho:** L · **Depende de:** —

## Contexto

Para um terminal funcional precisamos de um **pseudo-terminal (PTY)** no backend que rode
um shell real (PowerShell no Windows) e faça streaming de I/O para o frontend. Usamos a
crate `portable-pty` (ConPTY no Windows).

## Tarefas

- [ ] Adicionar dependências em [Cargo.toml](../../src-tauri/Cargo.toml): `portable-pty`.
- [ ] Criar `src-tauri/src/terminal.rs` com:
  - Estado gerenciado (`tauri::State`) de sessões PTY, indexado por `id: String`
    (`Mutex<HashMap<String, PtySession>>`).
  - `PtySession`: guarda o `Box<dyn MasterPty>`, o `writer` e o handle da thread de leitura.
- [ ] Comandos Tauri:
  - `term_create(id, cwd, cols, rows)` — abre o PTY, faz spawn do shell, inicia a thread
    de leitura que faz `emit` de `term://data/{id}` com os bytes lidos.
  - `term_write(id, data)` — escreve input do usuário no PTY.
  - `term_resize(id, cols, rows)` — ajusta o tamanho do PTY.
  - `term_close(id)` — mata o processo e remove a sessão.
- [ ] Registrar os comandos e o estado no [lib.rs](../../src-tauri/src/lib.rs)
      (`.manage(...)` + `invoke_handler`).
- [ ] Shell padrão: `powershell.exe` no Windows (detectar via `std::env::consts::OS`,
      fallback configurável depois).

## Arquivos

- `src-tauri/Cargo.toml` (+`portable-pty`)
- `src-tauri/src/terminal.rs` (novo)
- `src-tauri/src/lib.rs` (registrar módulo, estado e handlers)

## Detalhes técnicos

- **Streaming de saída:** a thread de leitura lê em blocos (`[u8; 4096]`) e emite via
  `app_handle.emit("term://data/{id}", payload)`. Para evitar flood, pode agrupar com um
  pequeno buffer/intervalo; começar simples (emitir por leitura) e otimizar se necessário.
- **Encoding:** PowerShell no Windows pode emitir UTF-8/UTF-16; enviar **bytes crus**
  (base64 ou `Vec<u8>` serializável) e deixar o xterm.js decodificar. Decisão: enviar
  `String` via `from_utf8_lossy` na v1 (simples); revisitar se houver lixo.
- **Permissões:** os eventos `term://data/*` precisam estar liberados no capability se o
  front usar `listen` — `core:event:default` já cobre `listen`/`emit` do front; validar.
- **Concorrência:** o `Mutex` protege o mapa; a thread de leitura possui o `reader` e não
  toca o mapa (só emite via `AppHandle`, que é `Clone + Send`).
- **Cleanup:** `term_close` deve dar `kill()` no child e dropar o master pra encerrar a thread.

## Riscos

- ConPTY exige Windows 10 1809+ — OK (máquina é Win 11).
- Travar o `Mutex` durante I/O longo: **não** segurar o lock enquanto lê/escreve grandes
  blocos; pegar o handle necessário e soltar o lock.

## Critérios de aceite

- [ ] `cargo check` limpo com a nova crate.
- [ ] Teste manual (via front da ISSUE-06): abre sessão, `dir` retorna listagem, input
      ecoa, `exit`/close encerra sem panic.
- [ ] Fechar a janela não deixa processos `powershell.exe` órfãos.
