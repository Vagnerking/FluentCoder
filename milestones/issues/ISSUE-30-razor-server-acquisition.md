# ISSUE-30 · Rust: aquisição e launch do rzls (Razor Language Server)

**Épico:** [Razor / .cshtml — IntelliSense no Monaco](../EPIC-lsp-razor-cshtml.md) · **Camada:** Rust · **Tamanho:** M · **Depende de:** 26

## Contexto

O **rzls** (Razor Language Server) é distribuído junto com o pacote Roslyn/C# tooling baixado na
ISSUE-26. Esta issue localiza o `rzls` dentro do pacote já extraído, constrói o comando de launch
com os argumentos necessários e expõe um comando Tauri para o front iniciar o servidor Razor.

## Tarefas

- [x] Criar `src-tauri/src/lsp/razor.rs`:
      - Função `rzls_executable_path(app) -> Result<PathBuf>`:
        - Verifica se `rzls`/`rzls.exe` existe no cache do Roslyn (ISSUE-26)
          (`app_data_dir()/lsp/roslyn/<versão>/{content/rzls,rzls,Razor}/`) **e** no
          local standalone `app_data_dir()/lsp/razor/`.
        - ⚠️ Download separado do NuGet: **STUB documentado** (`download_rzls`), NÃO executado
          (restrição da tarefa + depende do layout real da ISSUE-26).
        - Retorna o `PathBuf` do executável (erro claro se não encontrado).
      - Função `rzls_launch_command(app, project_root) -> Result<(String, Vec<String>)>`:
        - Chama `rzls_executable_path()`.
        - Monta `(program, args)` best-effort (`--logLevel Information`); args exatos a confirmar
          no spike contra um rzls real.
- [x] Implementar comando Tauri `lsp_ensure_razor_server() -> Result<String>`:
      - Retorna caminho do executável (o front usa para chamar `lsp_start_server`).
- [x] Registrar o comando em `lib.rs` e expor em `api.ts` (`ensureRazorServer`).
- [~] Emitir evento `"lsp-download-progress"` com `server: "razor"` — emitido no stub
      `download_rzls` (estado `"unavailable"`); fluxo de download real pendente.

## Arquivos

- `src-tauri/src/lsp/razor.rs` (novo)
- `src-tauri/src/lsp/mod.rs` (adicionar `mod razor;`)
- `src-tauri/src/lib.rs` (registrar `lsp_ensure_razor_server`)
- `src/api.ts` (adicionar `ensureRazorServer`)

## Detalhes técnicos

- O rzls geralmente está no mesmo pacote NuGet do `Microsoft.CodeAnalysis.LanguageServer` —
  verificar o conteúdo do arquivo extraído na ISSUE-26 (provavelmente em `content/rzls/`).
- Se não estiver incluído, o pacote separado é `Microsoft.AspNetCore.Razor.LanguageServer`.
- O rzls pode exigir que o Roslyn (C# LSP) já esteja rodando como servidor "host" — investigar
  se é um processo separado independente ou um plugin do C# server.
- Documentar no resultado da issue qual é o mecanismo de launch encontrado.

## Critérios de aceite

- [~] `rzls` é localizado no pacote Roslyn ou baixado separadamente — **localização** implementada
      (múltiplos candidatos); **download** é stub não executado (depende da ISSUE-26).
- [~] `lsp_ensure_razor_server()` retorna o caminho do executável sem erro — retorna o path quando o
      rzls está em cache; erro claro (`unavailable`) quando não está. Não testado com rzls real.
- [x] Comando de launch montado com argumentos best-effort (documentados em `RAZOR-SPIKE.md`).
- [x] `cargo check` passa.

> **Parcial (honesto).** Resolução de caminho + comando + IPC prontos e compilando.
> O download real do rzls NÃO foi implementado/executado (restrição da tarefa e
> dependência da ISSUE-26). Argumentos de launch são best-effort, a confirmar no spike real.
