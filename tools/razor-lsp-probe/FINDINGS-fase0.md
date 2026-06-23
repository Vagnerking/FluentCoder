# Fase 0 — Gate de validação do cohost Roslyn (Razor/CSHTML)

**Data:** 2026-06-23 · **Status do gate:** ✅ **PROSSEGUIR com o cohost (Opção A). NÃO pivotar para a Opção B ainda.**
Há **um** bloqueio nomeado e isolado (a seguir), com hipóteses de correção ranqueadas a validar na Fase B.

Reproduzir: `dotnet restore tools/razor-lsp-probe/fixtures/SampleMvc/SampleMvc.csproj` e
`node tools/razor-lsp-probe/probe.mjs` (ver [README](README.md)). Evidência bruta em `capture/` (git-ignored).

## Ambiente medido
- Server cohost (já em cache do app): `Microsoft.CodeAnalysis.LanguageServer.exe`, `RoslynVersion.txt` = **`5.9.0-1.26306.2`**, VSIX C# **2.144.9**. (Skew confirmado: `RoslynVersion.txt` 5.9.0-1.26306.2 vs `.deps.json` 5.9.0-1.26314.1.)
- Launch idêntico ao do app ([csharp.rs:365](../../src-tauri/src/lsp/csharp.rs#L365)): `--logLevel Information --extensionLogDirectory <dir> --stdio --extension <RazorExtension.dll> --csharpDesignTimePath <Targets/Microsoft.CSharpExtension.DesignTime.targets>`.
- `--help` deste server **não** tem `--razorSourceGenerator`/`--razorDesignTimePath` (flags legados do rzls.nvim antigo; o comentário em [csharp.rs:363](../../src-tauri/src/lsp/csharp.rs#L363) está correto para esta versão).
- Fixture: projeto MVC real `Microsoft.NET.Sdk.Web` (net8.0) com `_ViewImports.cshtml` (TagHelpers), `@model`, erro C# proposital e TagHelper.

## O que FUNCIONA (cohost saudável)
- `initialize` anuncia **todas** as capabilities semânticas: `hoverProvider`, `definitionProvider`, `typeDefinitionProvider`, `implementationProvider`, `referencesProvider`, `completionProvider` (trigger `.`/`<`/etc.), `documentSymbolProvider`, `codeActionProvider`, `semanticTokensProvider` (legenda C# completa), `inlayHintProvider`, `signatureHelpProvider`, `_vs_onAutoInsertProvider`.
- `project/open` → **`workspace/projectInitializationComplete` dispara**; log: *"Successfully completed load of SampleMvc.csproj"*.
- Razor extension sobe: *"Razor extension startup finished"*, *"Requesting 6 Razor cohost registrations"*.
- DevKit **não** é necessário (confirmado por pesquisa: vscode-csharp standalone e roslyn.nvim usam exatamente este launch, sem DevKit).

## O BLOQUEIO (root cause, com evidência)
**Toda** request Razor (diagnostics pull com qualquer identifier, `semanticTokens/full`, hover, definition, completion) falha com o **mesmo** erro `-32000`:

```
System.InvalidOperationException: Razor source generator is not referenced or no run result found
for project 'SampleMvc (net8.0)'.
   at Microsoft.CodeAnalysis.Remote.Razor.ProjectSystem.GeneratorRunResult.CreateAsync(Boolean throwIfNotFound, ...)
   at ...RemoteProjectSnapshot.GetRequiredCodeDocumentAsync(...)
   at ...RemoteDiagnosticsService / RazorSemanticTokensInfoService / RemoteHoverService / RemoteGoToDefinitionService / RemoteCompletionService
```
Log do servidor: *"Calling OOP with the 0 C# and 0 Html diagnostics"* logo antes de lançar.

Ou seja: o serviço **OOP** (`Microsoft.CodeAnalysis.Remote.Razor`) não encontra o **run result do Razor source generator** na compilação do projeto. É o ramo *"no run result"* de `GeneratorRunResult.CreateAsync` (não o ramo *"wrong ALC / referenced from X but expecting Y"* do vscode-csharp#9308 com SDKs antigos).

## O que descartamos / provamos
- **Resultado ROBUSTO (não é falso-negativo do probe).** O mesmo erro persiste em todas estas variações (descartando as causas levantadas na revisão do Codex):
  - `project/open` (.csproj) **e** `solution/open` (.sln real) → idêntico.
  - `workspace/configuration` respondido com `null` **e** espelhando exatamente o app (`csharpConfiguration.ts`: `*_diagnostics_scope: "openFiles"` etc.) → idêntico. (Importante: o app avisa que config nula leva Roslyn a `scope:"none"`; mesmo com a config correta, o erro persiste.)
  - `semanticTokens/range` (o cohost anuncia `full:false, range:true`) → idêntico.
  - `didClose`+`didOpen` (6 tentativas, versões até 7, backoff crescente) → idêntico.
  - Os erros `-32000` trazem **stack trace do servidor** (`Microsoft.CodeAnalysis.Remote.Razor...`), confirmando origem server-side, não framing do cliente.
- **O SDK referencia o gerador corretamente** (mas isso é só metade da prova). Reproduzindo o design-time build (`dotnet build -t:CoreCompile -p:DesignTimeBuild=true -p:SkipCompilerExecution=true ... -p:RazorDesignTimeTargets=... -p:CSharpDesignTimeTargetsPath=...` + `-getItem:Analyzer -getItem:AdditionalFiles`):
  - `Analyzer` inclui `...Sdks\Microsoft.NET.Sdk.Razor\source-generators\Microsoft.CodeAnalysis.Razor.Compiler.dll` (nome **bate** com o redirector → não é "wrong ALC").
  - `AdditionalFiles` inclui `Index.cshtml`, `_ViewImports.cshtml`, `_ViewStart.cshtml`.
  → Prova que o SDK **consegue** referenciar o gerador num design-time build. **Não** prova que a compilação do BuildHost do *próprio servidor* o fez — isso só um binlog do servidor confirma (Fase B, hipótese 2).
- O `Microsoft.CSharpExtension.DesignTime.targets` (polyfill) só injeta o gerador para projetos **não-SDK** (`UsingMicrosoftNETSdkRazor != 'true'`); projetos SDK.Web dependem do SDK.

## Conclusão do gate
O cohost é a engine certa: endpoints completos, projeto carrega, wiring do SDK correto, sem DevKit. O único bloqueio é o **run result do source generator ausente na compilação OOP** — um problema conhecido de cohosting em *primeira carga* (ver dotnet/razor#12069), **não** uma limitação arquitetural. Portanto: **seguir A**, resolver este bloqueio na Fase B com evidência.

## Hipóteses de correção para a Fase B (ranqueadas, a validar com o probe)
_Já descartadas em Fase 0: config nula (corrigida e mirrorada), `project/open` vs `solution/open`, `semanticTokens/full` vs `/range`, reabrir documento. Nenhuma resolve._

1. **Bump do server (mais provável e mais limpo).** Subir `CSHARP_EXT_VERSION` ([csharp.rs:251](../../src-tauri/src/lsp/csharp.rs#L251)) para um build com o fix de "generator no run result on first load" (dotnet/razor#12069; dotnet/roslyn#83993 corrigido por #83878; builds 5.9.0-1.26318.9 / -1.26322.12 são candidatos). Validação: extrair a VSIX nova e re-rodar o probe apontando `--roslyn` para ela. Se passar verde → o fix é uma mudança de uma linha.
2. **Binlog do BuildHost do próprio servidor.** Capturar/inspecionar a design-time build que o server roda (não o `dotnet build` manual) para confirmar se o analyzer Razor + AdditionalFiles entram na compilação que o Roslyn realmente usa. Distingue "analyzer ausente" de "analyzer presente mas generator não executou".
3. **`sourceGeneratorExecutionPreference` / gatilho de execução de generators.** Testar `--sourceGeneratorExecutionPreference Balanced` vs `Automatic` e/ou um trigger explícito de execução de generators após a carga.
4. **Recarregar a solução** (não só o documento) — workaround citado no #12069 — e/ou reabrir o projeto após o init.

## Matriz feature × resultado (server 5.9.0-1.26306.2; idêntico com project/open e solution/open, config mirrorada)
| Feature | Resultado |
|---|---|
| initialize / capabilities | ✅ todas anunciadas |
| projectInitializationComplete | ✅ dispara |
| pull diagnostics (todas as identifiers) | ❌ -32000 "no run result" |
| semanticTokens/range | ❌ -32000 |
| hover @Model.City | ❌ -32000 |
| definition @Model.City | ❌ -32000 |
| completion após @Model. | ❌ -32000 |
| requests `razor/*` server→client (insumo Fase C) | nenhum nesta execução (provável que surjam após o gerador funcionar) |

## Referências
dotnet/razor#12069 (generator no outputs on first load) · dotnet/roslyn#82535 (flags razor não documentados) · dotnet/roslyn#83993 / #83878 (fix) · dotnet/vscode-csharp#9308 (wrong ALC com SDK antigo) · dotnet/razor#11834, #12332 (cohost exige generator + AdditionalFiles) · seblyng/roslyn.nvim (cohost OSS sem DevKit, min 5.8.0-1.26262.10).
