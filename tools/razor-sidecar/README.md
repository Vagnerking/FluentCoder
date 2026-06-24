# Razor live projection sidecar

A long-lived .NET process that hosts the **real Razor source generator** and
re-emits a `.cshtml`'s projected C# (`.g.cs`) from **in-memory text** in ~tens of
ms (warm). It is the "fast path" of ADR 0002: the editor uses it for per-keystroke
live validation instead of paying the ~1s `dotnet build -p:EmitCompilerGeneratedFiles=true`
on save.

It only **produces `.g.cs` text**. The standalone Roslyn LSP (loaded with the
shadow + user project) still does the semantic analysis (diagnostics/hover/
completion); the broker remaps results via the `#line` source map.

## Protocol — newline-delimited JSON (NDJSON) over stdio

One request object per stdin line; one response object per stdout line. **stdout
is protocol-only; all logging goes to stderr** (`[razor:sidecar] ...`).

### Requests

`ping` — liveness check:
```json
{ "id": 1, "kind": "ping" }
```

`warm` — build/prime a project session (pays the cold generator cost up front):
```json
{ "id": 2, "kind": "warm", "projectDir": "...", "cshtmlPath": "...", "cshtmlText": "...", <project inputs> }
```

`emit` — re-emit one `.cshtml` from in-memory text:
```json
{ "id": 3, "kind": "emit", "projectDir": "...", "cshtmlPath": "...", "cshtmlText": "<p>@Model.X</p>", <project inputs> }
```

**Project inputs** (carried by `warm`/`emit`):
- `references`: absolute paths of the project's compile reference DLLs (from
  `dotnet build -t:ResolveAssemblyReferences --getItem:ReferencePath`). TagHelper
  discovery + base types come from these.
- `rootNamespace`, `razorLangVersion` (e.g. `"8.0"`), `usingMicrosoftNetSdkWeb`
  (bool), `tfm` (e.g. `"net8.0"`) — the editorconfig globals the generator reads.
- `viewImportsPath`/`viewImportsText`, `viewStartPath`/`viewStartText` — the
  project-level Razor imports, fed as AdditionalTexts (change on save, not per key).
- `files`: `[{ path, targetPathB64 }]` — every AdditionalText's
  `build_metadata.AdditionalFiles.TargetPath`, **base64 of the project-relative
  path with `\` separators** (drives the generated class name + route).

### Responses
```json
{ "id": 3, "ok": true, "generatedText": "...the .g.cs..." }
{ "id": 9, "ok": false, "error": "message" }
```

## Sessions & performance

The sidecar keeps one `GeneratorDriver` per project (keyed by `projectDir`). An
`emit` replaces only the changed `.cshtml`'s `AdditionalText` and re-runs the
driver — the incremental warm path (~3ms in the spike). The session rebuilds
(cold ~789ms) when the reference set changes.

## Version pin (important)

`Microsoft.CodeAnalysis.Razor.Compiler.dll` (SDK 8.0.421) references
`Microsoft.CodeAnalysis 4.9.0.0`. The csproj pins `Microsoft.CodeAnalysis.CSharp`
to `4.9.2`; a mismatch makes the generator's types fail to load
(`ReflectionTypeLoadException`). The generator DLL is located in the installed
SDKs (prefers the 8.0.x band); override with the `RAZOR_COMPILER_DLL` env var.

## Build / run

Built on first use into the app cache (so the host Roslyn band can match the
user's SDK), launched as `dotnet exec RazorSidecar.dll`. For a manual test, pipe
NDJSON requests into `dotnet run -c Release`.
