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

The durable Fase 0 conclusion is summarized into `FINDINGS-fase0.md` and reviewed with Codex.

## b1 spike (Option B feasibility) — `spike-b1.mjs`

Proves the in-house projection path: the real Razor compiler emits a projected
`.g.cs` with `#line` maps; the plain standalone Roslyn C# LSP gives real
diagnostics/hover/definition on it (remappable to `.cshtml`). Uses the
`fixtures/Shadow` project (plain SDK, no Razor generator, references the app
model + the projected `.g.cs`).

```powershell
# 1. produce the projected C# (writes obj/.../generated/.../Index_cshtml.g.cs)
dotnet build tools/razor-lsp-probe/fixtures/SampleMvc/SampleMvc.csproj -p:EmitCompilerGeneratedFiles=true
# 2. copy it where the shadow project expects it (git-ignored, has machine #line paths)
#    -> tools/razor-lsp-probe/fixtures/Shadow/projected/Index_cshtml.g.cs
# 3. run the spike
node tools/razor-lsp-probe/spike-b1.mjs
```

Result (FINDINGS-fase0.md): hover on `Model.City` → `string WeatherModel.City { get; set; }`;
definition → `WeatherModel.cs`; diagnostics → `CS1061`. Gate met.

## What it probes

initialize → capabilities · `project/open` → `projectInitializationComplete` ·
pull diagnostics (no id + `syntax`/`DocumentCompilerSemantic`/`Razor`) ·
`semanticTokens/full` · hover/definition on `@Model.City` · completion after
`@Model.` · and it records every server→client `razor/*` request.
