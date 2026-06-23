# razor-lsp-probe — Fase 0 gate

Headless capture of the **Roslyn cohosting** language server's behavior for
`.cshtml`/`.razor`, without Tauri/Monaco/UI. This is the evidence gate that
decides whether the "fix the cohost" path (Option A) actually delivers semantic
features, or whether we pivot to in-house projection (Option B).

It drives the *same* server the app launches: the C# extension VSIX's
`Microsoft.CodeAnalysis.LanguageServer.exe` + `Microsoft.VisualStudioCode.RazorExtension.dll`
(see `src-tauri/src/lsp/csharp.rs` `cohosting_launch_command`).

## Run

```powershell
# 1. restore the sample fixture so Roslyn can design-time load it
dotnet restore tools/razor-lsp-probe/fixtures/SampleMvc/SampleMvc.csproj

# 2. run the probe (defaults to the fixture)
node tools/razor-lsp-probe/probe.mjs
```

Override target / server:

```powershell
node tools/razor-lsp-probe/probe.mjs --root <projDir> --csproj <file.csproj> --cshtml <file.cshtml>
node tools/razor-lsp-probe/probe.mjs --roslyn "<...>\extension\.roslyn"
```

## Output (under `capture/`, git-ignored)

- `transcript-<ts>.jsonl` — every JSON-RPC message, both directions.
- `summary-<ts>.md` — capabilities, project-init status, per-feature probe
  results, and any `razor/*` / dynamic-file requests the server sent (the
  contract input for Fase C / HTML delegation).
- `server-logs/` — the cohost's own `--extensionLogDirectory` output.

The durable Fase 0 conclusion is summarized into `docs/` and reviewed with Codex.

## What it probes

initialize → capabilities · `project/open` → `projectInitializationComplete` ·
pull diagnostics (no id + `syntax`/`DocumentCompilerSemantic`/`Razor`) ·
`semanticTokens/full` · hover/definition on `@Model.City` · completion after
`@Model.` · and it records every server→client `razor/*` request.
