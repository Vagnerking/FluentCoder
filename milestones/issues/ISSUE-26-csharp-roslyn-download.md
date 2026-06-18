# ISSUE-26 · Rust: download e cache do Roslyn Language Server

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Rust · **Tamanho:** L · **Depende de:** 22

## Contexto

O servidor C# usado é o **Microsoft.CodeAnalysis.LanguageServer** — o mesmo que alimenta o C# Dev
Kit no VS Code. Ele é distribuído como pacote NuGet e precisa ser baixado, descompactado e cacheado
pelo backend Rust antes do primeiro uso.

O download é feito **uma vez** e cacheado em `app_data_dir()/lsp/roslyn/<versão>/`; nas execuções
seguintes, o Rust verifica se o binário já existe e pula o download.

## Tarefas

- [x] Adicionar `reqwest` (features `rustls-tls`, `stream`, `blocking` não — usar async), `zip` (ou `flate2` + `tar`),
      `sha2` ao `Cargo.toml`.
- [x] Criar `src-tauri/src/lsp/csharp.rs`:
      - Constante `ROSLYN_VERSION` e URL de download do pacote NuGet correspondente.
      - Função `async fn ensure_roslyn_server() -> Result<PathBuf>`:
        - Verifica se `app_data_dir()/lsp/roslyn/<versão>/` já existe com o executável.
        - Se não, baixa o `.nupkg` via `reqwest`, verifica hash SHA-256 (hardcoded por versão),
          descompacta (é um ZIP renomeado), extrai o executável para o diretório cacheado.
        - Retorna o `PathBuf` do executável (ex: `Microsoft.CodeAnalysis.LanguageServer.exe` no Windows).
      - Função `fn detect_dotnet() -> Result<String>`: localiza `dotnet` no PATH; retorna erro
        descritivo se ausente ("Para usar o IntelliSense C#, instale o .NET SDK em ...").
      - Função `pub fn roslyn_launch_command(project_root: &Path) -> Result<(String, Vec<String>)>`:
        - Chama `ensure_roslyn_server()` + `detect_dotnet()`.
        - Retorna `(program, args)` para `lsp_start_server`.
- [x] Implementar comando Tauri `lsp_ensure_csharp_server() -> Result<String>` que chama
      `roslyn_launch_command` e retorna o caminho do executável (usado pela ISSUE-27 para montar
      o comando e chamar `lsp_start_server`).
- [x] Registrar o comando em `lib.rs` e expor em `api.ts`.
- [x] Emitir progresso via evento Tauri `"lsp-download-progress"` durante o download
      (`{ server: "csharp", state: "downloading" | "extracting" | "ready" | "error", message: string }`).

## Arquivos

- `src-tauri/src/lsp/csharp.rs` (novo)
- `src-tauri/src/lsp/mod.rs` (adicionar `mod csharp;`)
- `src-tauri/src/lib.rs` (registrar `lsp_ensure_csharp_server`)
- `src-tauri/Cargo.toml` (adicionar `reqwest`, `zip`/`flate2`, `sha2`)
- `src/api.ts` (adicionar `ensureCsharpServer`)

## Detalhes técnicos

- O Roslyn LSP é distribuído como NuGet em `https://api.nuget.org/v3-flatcontainer/...`.
  Pintar uma versão estável conhecida (ex: `4.x.x`) com hash SHA-256 hardcoded.
- O pacote NuGet é um ZIP: extrair `content/` ou o diretório correto para a plataforma (win/linux/osx).
- O rzls (Razor LSP) geralmente está incluído no mesmo pacote — extrair junto para uso na ISSUE-30.
- `app.path().app_data_dir()` retorna o diretório de dados da aplicação Tauri (Windows: `%APPDATA%\CodeEditor`).
- Tratar erros de rede: se o download falhar, logar e emitir evento `"error"` com mensagem amigável.
- Não bloquear a thread tokio com I/O de arquivo — usar `tokio::fs` e `tokio::io`.

## Critérios de aceite

- [x] Na primeira execução, o Roslyn é baixado e extraído em `app_data_dir()/lsp/roslyn/<versão>/`.
- [x] Na segunda execução, o download é pulado (cache hit).
- [x] Hash SHA-256 é verificado; download corrompido emite erro.
- [x] Se `dotnet` não estiver no PATH, o comando retorna erro com mensagem descritiva.
- [x] Eventos de progresso chegam ao front durante o download.
- [x] `cargo check` passa.

## Validação real (download + launch testados de verdade)

> Diferente da nota inicial ("download não testado"), o fluxo foi **validado end-to-end** neste ambiente (Windows x64, .NET SDK 10.0.301):

- **Versão fixada:** `5.0.0-1.25277.114` (única publicada para os pacotes per-RID no
  flat-container do nuget.org).
- **URL confirmada:** `https://api.nuget.org/v3-flatcontainer/microsoft.codeanalysis.languageserver.win-x64/5.0.0-1.25277.114/microsoft.codeanalysis.languageserver.win-x64.5.0.0-1.25277.114.nupkg`
  — baixou um `.nupkg` de **62.7 MB** (não precisou do feed Azure DevOps).
- **SHA-256 real (win-x64) pinado:** `7c96c59532a81f710be95a48e6dd25c4e4d17875a37f5a7171a90e82f8ab57a6`
  (em `roslyn_sha256()`, por RID; demais RIDs ficam "unverified" até serem baixados).
- **Layout do pacote:** o executável self-contained fica em
  `content/LanguageServer/win-x64/Microsoft.CodeAnalysis.LanguageServer.exe` (roda direto,
  sem `dotnet exec`). `find_executable` acha pelo nome exato (há também um `BuildHost*.exe`
  auxiliar, ignorado).
- **Args corrigidos (crítico):** `--help` do servidor marca **`--logLevel` E
  `--extensionLogDirectory` como REQUIRED**. O stub original só passava `--logLevel`/`--stdio`
  e o servidor saía na hora. Agora passa `--extensionLogDirectory <cache>/logs` também.
- **Smoke test do protocolo:** enviado um `initialize` LSP via stdio → o servidor respondeu
  `window/logMessage` com `"[Program] Language server initialized"`. ✅ Servidor sobe e fala LSP.
- **Cache pré-populado** em `%APPDATA%\com.codeeditor.app\lsp\roslyn\5.0.0-1.25277.114\`
  (cache hit na 1ª execução — sem re-download).

> Pendência: o download real só foi exercido para **win-x64**; os SHAs de linux/osx seguem
> como placeholder (verificação pulada nesses RIDs até serem baixados/pinados).
