// Live Razor projection sidecar — NDJSON service over stdio (ADR 0002 fast path).
//
// One request object per stdin line; one response object per stdout line.
// stdout is PROTOCOL ONLY; all logging goes to stderr. Keeps one GeneratorDriver
// per project (keyed by projectDir) so a keystroke re-emit replaces just the
// target .cshtml's AdditionalText and re-runs the driver (~tens of ms warm).
//
// Request kinds:
//   ping  -> { id, ok }
//   warm  -> build/prime the project session (cold cost), no specific edit
//   emit  -> re-emit one .cshtml from in-memory text -> { id, ok, generatedText }
//
// See README.md for the full protocol + the editorconfig contract.

using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

var sidecar = new Sidecar();
return await sidecar.RunAsync();

// ── Service loop ──────────────────────────────────────────────────────────────
sealed class Sidecar
{
    private readonly Dictionary<string, ProjectSession> _sessions = new();
    private static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public async Task<int> RunAsync()
    {
        // Force UTF-8 on stdio so generated text round-trips regardless of console.
        // The setter can throw when the process has no console (spawned with
        // redirected pipes + CREATE_NO_WINDOW) — the explicit encodings on the
        // reader/writer below cover us, so a failure here must not kill the boot.
        try { Console.InputEncoding = Encoding.UTF8; } catch { /* no console */ }
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = false };
        var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        Log("razor sidecar ready");

        string? line;
        while ((line = await stdin.ReadLineAsync()) is not null)
        {
            if (line.Length == 0) continue;
            Response resp;
            long id = 0;
            try
            {
                var req = JsonSerializer.Deserialize<Request>(line, Json)
                          ?? throw new Exception("null request");
                id = req.Id;
                resp = Handle(req);
            }
            catch (Exception ex)
            {
                Log($"request error: {ex}");
                resp = new Response { Id = id, Ok = false, Error = ex.Message };
            }
            await stdout.WriteLineAsync(JsonSerializer.Serialize(resp, Json));
            await stdout.FlushAsync();
        }
        Log("razor sidecar stdin closed — exiting");
        return 0;
    }

    private Response Handle(Request req) => req.Kind switch
    {
        "ping" => new Response { Id = req.Id, Ok = true },
        "warm" => Warm(req),
        "emit" => Emit(req),
        _ => new Response { Id = req.Id, Ok = false, Error = $"unknown kind '{req.Kind}'" },
    };

    private Response Warm(Request req)
    {
        var session = GetOrCreateSession(req);
        // A warm runs the generator once on the current target text to pay the
        // cold JIT + TagHelper-scan cost up front.
        session.Emit(req.CshtmlPath!, req.CshtmlText ?? "");
        return new Response { Id = req.Id, Ok = true };
    }

    private Response Emit(Request req)
    {
        var session = GetOrCreateSession(req);
        string text = session.Emit(req.CshtmlPath!, req.CshtmlText ?? "");
        if (text.Length == 0)
        {
            // Never report an empty projection as success: the host would open
            // blank C# in Roslyn (or silently keep serving a stale one) with no
            // clue why. ReadGenerated already logged the specifics to stderr.
            return new Response
            {
                Id = req.Id,
                Ok = false,
                Error = $"generator produced no output for '{Path.GetFileName(req.CshtmlPath!)}'",
            };
        }
        return new Response { Id = req.Id, Ok = true, GeneratedText = text };
    }

    /// Keep at most this many project sessions: each holds a full Compilation +
    /// MetadataReferences (hundreds of DLLs in a monorepo). Unbounded growth across
    /// many opened projects would leak memory for the app's lifetime.
    private const int MaxSessions = 4;
    private readonly Dictionary<string, long> _lastUse = new();
    private long _useTick;

    private ProjectSession GetOrCreateSession(Request req)
    {
        string key = req.ProjectDir ?? "";
        _lastUse[key] = ++_useTick;
        // Rebuild the session if references changed (new refs hash) — TagHelper
        // discovery and the compilation depend on them.
        string refsHash = ProjectSession.HashRefs(req.References ?? new());
        if (_sessions.TryGetValue(key, out var existing) && existing.RefsHash == refsHash)
        {
            // Refresh globals + per-file TargetPath + shared texts for THIS request
            // (a different .cshtml / changed RootNamespace etc. must take effect).
            existing.Apply(req);
            return existing;
        }
        var session = ProjectSession.Create(req, refsHash);
        _sessions[key] = session;
        // Evict the least-recently-used session beyond the cap (never the one we
        // just created/refreshed).
        while (_sessions.Count > MaxSessions)
        {
            var oldest = _lastUse.Where(kv => kv.Key != key && _sessions.ContainsKey(kv.Key))
                .OrderBy(kv => kv.Value).Select(kv => kv.Key).FirstOrDefault();
            if (oldest is null) break;
            _sessions.Remove(oldest);
            _lastUse.Remove(oldest);
            Log($"evicted project session '{oldest}' (cap {MaxSessions})");
        }
        return session;
    }

    public static void Log(string msg) => Console.Error.WriteLine($"[razor:sidecar] {msg}");
}

// ── One project's compilation + generator driver ──────────────────────────────
sealed class ProjectSession
{
    public string RefsHash { get; }
    private GeneratorDriver _driver;
    private readonly CSharpCompilation _compilation;
    private readonly IIncrementalGenerator _generator;
    // The ONE options provider the driver references; refreshed every request.
    private readonly EditorConfigOptions _options = new();
    // Live AdditionalText handles, keyed by a NORMALIZED path (backslashes, lower)
    // so the same `.cshtml` sent with `/` vs `\` (or different case) is treated as
    // ONE file — else the Razor generator throws on a duplicate hintName.
    private readonly Dictionary<string, AdditionalText> _texts = new(StringComparer.Ordinal);

    /// Canonical key for a path: backslashes, lowercased — matches how two forms of
    /// the same file must collapse to one AdditionalText.
    private static string NormKey(string path) => path.Replace('/', '\\').ToLowerInvariant();
    // Last globals signature the driver was built/run against — a change forces a
    // driver rebuild (incremental gen wouldn't otherwise notice a globals-only edit).
    private string _globalsSig = "";

    private ProjectSession(string refsHash, CSharpCompilation compilation, IIncrementalGenerator generator)
    {
        RefsHash = refsHash;
        _compilation = compilation;
        _generator = generator;
        _driver = null!; // assigned in Create right after construction
    }

    /// Refresh per-request inputs (globals + per-file TargetPath + shared texts)
    /// that don't change the reference set. Call before every warm/emit.
    public void Apply(Request req)
    {
        _options.Update(req);
        // The full hierarchical `_ViewImports`/`_ViewStart` chain rides in `files`
        // (each with its text). Register/refresh every one so subfolder/Area views
        // get their nearest imports/layout. The singular fields are kept for
        // back-compat but are a subset of the chain.
        foreach (var f in req.Files ?? new())
            if (f.Text is not null)
                ReplaceSharedIfChanged(f.Path, f.Text);
        ReplaceSharedIfChanged(req.ViewImportsPath, req.ViewImportsText);
        ReplaceSharedIfChanged(req.ViewStartPath, req.ViewStartText);
    }

    /// If the global options changed since the last run, recreate the driver with a
    /// fresh provider snapshot + the current AdditionalTexts (the only way an
    /// incremental generator re-reads globals when the .cshtml text is unchanged).
    private void RebuildDriverIfGlobalsChanged()
    {
        string sig = _options.GlobalsSignature;
        if (sig == _globalsSig && _driver is not null) return;
        _globalsSig = sig;
        var texts = System.Collections.Immutable.ImmutableArray.CreateRange(_texts.Values);
        _driver = CSharpGeneratorDriver.Create(
            generators: new[] { _generator.AsSourceGenerator() },
            additionalTexts: texts,
            parseOptions: new CSharpParseOptions(LanguageVersion.Latest),
            optionsProvider: _options);
    }

    public static string HashRefs(List<string> refs)
    {
        // Order- and case-insensitive stable hash of the reference set (paths are
        // hashed case-folded — sorting case-insensitively but hashing the original
        // chars made the SAME set hash differently across path-case variations).
        unchecked
        {
            ulong h = 1469598103934665603UL;
            foreach (var r in refs.Select(x => x.ToLowerInvariant()).OrderBy(x => x, StringComparer.Ordinal))
                foreach (char c in r) { h ^= c; h *= 1099511628211UL; }
            return h.ToString("x16");
        }
    }

    public static ProjectSession Create(Request req, string refsHash)
    {
        var generator = LoadRazorGenerator();
        var all = req.References ?? new();
        var missing = all
            .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && !File.Exists(p))
            .ToList();
        if (missing.Count > 0)
            // Loud, not silent: without these assemblies TagHelper discovery and
            // the projected types degrade — the host surfaces the same list to the
            // editor as missingReferences (honest degraded mode).
            Sidecar.Log($"session '{req.ProjectDir}': {missing.Count} reference DLL(s) missing on disk — first: {missing[0]}");
        var refs = all
            .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && File.Exists(p))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();
        var compilation = CSharpCompilation.Create(
            "ShadowRazor",
            syntaxTrees: Array.Empty<SyntaxTree>(),
            references: refs,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var session = new ProjectSession(refsHash, compilation, generator);
        session._options.Update(req);
        session._globalsSig = session._options.GlobalsSignature;

        // Seed the shared additional texts (_ViewImports / _ViewStart) + the target.
        var additional = session.BuildAdditionalTexts(req, req.CshtmlPath, req.CshtmlText ?? "");
        session._driver = CSharpGeneratorDriver.Create(
            generators: new[] { generator.AsSourceGenerator() },
            additionalTexts: additional,
            parseOptions: new CSharpParseOptions(LanguageVersion.Latest),
            optionsProvider: session._options);
        return session;
    }

    private void ReplaceSharedIfChanged(string? path, string? text)
    {
        if (path is null || text is null) return;
        var nk = NormKey(path);
        if (_texts.TryGetValue(nk, out var old) && old.GetText()?.ToString() == text) return;
        var fresh = new InMemoryText(path, text);
        _driver = old is not null
            ? _driver.ReplaceAdditionalText(old, fresh)
            : _driver.AddAdditionalTexts(System.Collections.Immutable.ImmutableArray.Create<AdditionalText>(fresh));
        _texts[nk] = fresh;
    }

    /// Re-emit `cshtmlPath` with `text`; returns the generated C#.
    public string Emit(string cshtmlPath, string text)
    {
        // A globals-only change (e.g. RootNamespace/TFM after a .csproj edit) needs
        // a fresh driver, or the incremental generator reuses stale output.
        RebuildDriverIfGlobalsChanged();
        var nk = NormKey(cshtmlPath);
        if (_texts.TryGetValue(nk, out var old) && old.GetText()?.ToString() == text)
        {
            // Unchanged — still run to fetch the cached output.
            _driver = _driver.RunGenerators(_compilation);
            return ReadGenerated(cshtmlPath);
        }
        var fresh = new InMemoryText(cshtmlPath, text);
        _driver = old is not null
            ? _driver.ReplaceAdditionalText(old, fresh)
            : _driver.AddAdditionalTexts(System.Collections.Immutable.ImmutableArray.Create<AdditionalText>(fresh));
        _texts[nk] = fresh;
        _driver = _driver.RunGenerators(_compilation);
        return ReadGenerated(cshtmlPath);
    }

    private System.Collections.Immutable.ImmutableArray<AdditionalText> BuildAdditionalTexts(
        Request req, string? targetPath, string targetText)
    {
        var list = new List<AdditionalText>();
        // DEDUP by path: the Razor generator throws (duplicate hintName) if the
        // same `.cshtml` is added twice. This happens when the target file IS one
        // of the shared imports (e.g. the user opened `_ViewStart.cshtml` itself,
        // or the project's `_ViewStart`/`_ViewImports` also appears as a target).
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void add(string? path, string? text)
        {
            if (path is null || text is null) return;
            var nk = NormKey(path);
            if (!seen.Add(nk)) return; // already added (same file, any path form)
            var t = new InMemoryText(path, text);
            _texts[nk] = t;
            list.Add(t);
        }
        // The hierarchical import/viewstart chain (each FileSpec with text), then
        // the singular fields (a subset, deduped by path), then the target last.
        foreach (var f in req.Files ?? new())
            if (f.Text is not null)
                add(f.Path, f.Text);
        add(req.ViewImportsPath, req.ViewImportsText);
        add(req.ViewStartPath, req.ViewStartText);
        if (targetPath is not null) add(targetPath, targetText);
        return System.Collections.Immutable.ImmutableArray.CreateRange(list);
    }

    private string ReadGenerated(string cshtmlPath)
    {
        var result = _driver.GetRunResult();

        // PRIMARY: match by the file's full TargetPath. The Razor generator derives
        // the hintName from the AdditionalText's TargetPath (project-relative, e.g.
        // `Views\Home\Index.cshtml`) by replacing separators/dots — so two views
        // that share a stem (`Views/Home/Index.cshtml` vs
        // `Areas/Admin/Views/Home/Index.cshtml`) get DISTINCT hintNames. EXACT
        // sanitized equality first: an unanchored EndsWith would still let
        // `views_home_index_cshtml_g_cs` match the AREA view's longer hintName.
        string? wantPath = _options.SanitizedTargetSuffix(cshtmlPath);
        if (wantPath is not null)
        {
            foreach (var gen in result.Results)
                foreach (var src in gen.GeneratedSources)
                    if (Sanitize(src.HintName).Equals(wantPath, StringComparison.OrdinalIgnoreCase))
                        return src.SourceText.ToString();
            // Equality can miss if the generator prefixed the hintName (it has
            // varied across SDK bands) — fall back to a suffix match only when it
            // is UNAMBIGUOUS across all generated sources.
            var pathMatches = result.Results
                .SelectMany(r => r.GeneratedSources)
                .Where(s => Sanitize(s.HintName).EndsWith(wantPath, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (pathMatches.Count == 1)
                return pathMatches[0].SourceText.ToString();
        }

        // FALLBACK: filename-only suffix. Only safe when exactly ONE generated
        // source ends with it — otherwise an ambiguous stem could return the wrong
        // view, which is the bug we're avoiding, so we bail to empty instead.
        string wantFileSuffix = Path.GetFileName(cshtmlPath).Replace('.', '_') + ".g.cs";
        var fileMatches = result.Results
            .SelectMany(r => r.GeneratedSources)
            .Where(s => s.HintName.EndsWith(wantFileSuffix, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (fileMatches.Count == 1)
            return fileMatches[0].SourceText.ToString();

        // Diagnose an empty/ambiguous result: what DID the generator produce, and why?
        var hints = result.Results.SelectMany(r => r.GeneratedSources).Select(s => s.HintName).ToList();
        var diags = result.Results.SelectMany(r => r.Diagnostics).Select(d => d.ToString()).Take(5).ToList();
        Sidecar.Log($"ReadGenerated EMPTY for '{Path.GetFileName(cshtmlPath)}' " +
                    $"(want path {wantPath ?? "(no TargetPath)"} or unique *{wantFileSuffix}, " +
                    $"got {fileMatches.Count} filename matches); " +
                    $"hints=[{string.Join(", ", hints)}]; refs={_compilation.References.Count()}; " +
                    $"texts=[{string.Join(", ", _texts.Keys.Select(Path.GetFileName))}]; " +
                    $"diags=[{string.Join(" | ", diags)}]");
        return "";
    }

    /// Sanitize a hintName/target path the way the Razor generator names sources:
    /// separators and dots collapse to `_`. Lets us compare a hintName against an
    /// expected TargetPath suffix regardless of `/` vs `\`.
    private static string Sanitize(string s) =>
        s.Replace('/', '_').Replace('\\', '_').Replace('.', '_');

    // ── Load the Razor generator from the resolved SDK ────────────────────────
    private static IIncrementalGenerator LoadRazorGenerator()
    {
        string dll = ResolveRazorCompilerDll();
        var asm = Assembly.LoadFrom(dll);
        var type = asm.GetType("Microsoft.NET.Sdk.Razor.SourceGenerators.RazorSourceGenerator")
                   ?? throw new Exception($"RazorSourceGenerator type not in {dll}");
        return (IIncrementalGenerator)Activator.CreateInstance(type)!;
    }

    /// Locate `Microsoft.CodeAnalysis.Razor.Compiler.dll` in the installed SDKs.
    /// Prefers the band matching the pinned Roslyn (8.0.x); falls back to newest.
    /// Portable across Windows/macOS/Linux and custom .NET installs: honors an
    /// explicit override, then `DOTNET_ROOT`, then the running runtime's own dotnet
    /// root, then the OS default — instead of assuming `%ProgramFiles%\dotnet`.
    private static string ResolveRazorCompilerDll()
    {
        // 1. Explicit override (the Rust host can pass the exact DLL path).
        string? overridePath = Environment.GetEnvironmentVariable("RAZOR_COMPILER_DLL");
        if (!string.IsNullOrEmpty(overridePath) && File.Exists(overridePath)) return overridePath;

        // 2. Try each candidate `dotnet` root for an `sdk/` dir, in priority order.
        var tried = new List<string>();
        foreach (var sdksRoot in DotnetSdkRoots())
        {
            tried.Add(sdksRoot);
            if (!Directory.Exists(sdksRoot)) continue;
            var candidates = Directory.GetDirectories(sdksRoot)
                .Select(d => Path.Combine(d,
                    "Sdks", "Microsoft.NET.Sdk.Razor", "source-generators",
                    "Microsoft.CodeAnalysis.Razor.Compiler.dll"))
                .Where(File.Exists)
                .ToList();
            if (candidates.Count == 0) continue;
            // Prefer 8.0.x (matches the pinned Roslyn 4.9.x); else newest. Match the
            // `8.0.` band with an OS-agnostic separator so it works on Linux/macOS too.
            var pinned = candidates.FirstOrDefault(p =>
                p.Contains($"{Path.DirectorySeparatorChar}8.0.", StringComparison.OrdinalIgnoreCase) ||
                p.Contains("/8.0.", StringComparison.OrdinalIgnoreCase));
            return pinned ?? candidates.OrderByDescending(p => p).First();
        }
        throw new Exception(
            $"no Razor.Compiler.dll under any dotnet SDK dir (tried: {string.Join(", ", tried)}). " +
            "Set DOTNET_ROOT or RAZOR_COMPILER_DLL.");
    }

    /// Candidate `dotnet/sdk` directories, most-specific first: DOTNET_ROOT
    /// (+ x64 variant), the running runtime's dotnet root, then the OS default.
    private static IEnumerable<string> DotnetSdkRoots()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        IEnumerable<string> FromRoot(string? root)
        {
            if (string.IsNullOrEmpty(root)) yield break;
            var sdk = Path.Combine(root, "sdk");
            if (seen.Add(sdk)) yield return sdk;
        }

        foreach (var s in FromRoot(Environment.GetEnvironmentVariable("DOTNET_ROOT"))) yield return s;
        foreach (var s in FromRoot(Environment.GetEnvironmentVariable("DOTNET_ROOT(x64)"))) yield return s;

        // The runtime we're executing under lives at `<dotnetRoot>/shared/Microsoft.NETCore.App/<ver>`;
        // walk up to `<dotnetRoot>`. This finds the active install even when it's
        // not on a default path (e.g. a user-local or CI dotnet).
        string runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        var sharedApp = Directory.GetParent(runtimeDir.TrimEnd(Path.DirectorySeparatorChar))?.Parent?.Parent?.FullName;
        foreach (var s in FromRoot(sharedApp)) yield return s;

        // OS defaults, last.
        if (OperatingSystem.IsWindows())
        {
            foreach (var s in FromRoot(Path.Combine(
                Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files", "dotnet")))
                yield return s;
        }
        else
        {
            foreach (var root in new[] { "/usr/lib/dotnet", "/usr/share/dotnet", "/usr/local/share/dotnet" })
                foreach (var s in FromRoot(root)) yield return s;
        }
    }
}

// ── In-memory AdditionalText ──────────────────────────────────────────────────
sealed class InMemoryText : AdditionalText
{
    private readonly SourceText _text;
    public InMemoryText(string path, string text)
    {
        Path = path;
        _text = SourceText.From(text, Encoding.UTF8);
    }
    public override string Path { get; }
    public override SourceText GetText(CancellationToken cancellationToken = default) => _text;
}

// ── AnalyzerConfigOptions: the editorconfig contract the generator reads ───────
// Mutable + session-owned: the GeneratorDriver holds ONE provider for the session
// lifetime, so every request must refresh the globals + per-file TargetPath map
// via Update() before RunGenerators — otherwise a 2nd .cshtml in the project (or a
// changed global) would be missing its TargetPath / use stale options.
sealed class EditorConfigOptions : AnalyzerConfigOptionsProvider
{
    private Dictionary<string, string> _globals = new();
    private readonly Dictionary<string, Dictionary<string, string>> _perFile = new(StringComparer.OrdinalIgnoreCase);

    /// Key for `_perFile`: separator-normalized so the same file sent with `/` in
    /// one request and `\` in another (host path forms vary) hits ONE entry —
    /// a miss here silently loses the file's TargetPath and breaks hintName
    /// resolution. Case-insensitivity comes from the dictionary's comparer.
    private static string PathKey(string p) => p.Replace('/', '\\');

    /// A stable signature of the GLOBAL options, so the session can detect a
    /// globals-only change (RootNamespace/TFM/...) and rebuild the driver — an
    /// incremental generator keyed on the provider's identity would otherwise reuse
    /// cached output when only globals changed but the .cshtml text didn't.
    public string GlobalsSignature =>
        string.Join("|", _globals.OrderBy(kv => kv.Key).Select(kv => $"{kv.Key}={kv.Value}"));

    public void Update(Request req)
    {
        _globals = new()
        {
            ["build_property.RootNamespace"] = req.RootNamespace ?? "",
            ["build_property.RazorLangVersion"] = req.RazorLangVersion ?? "8.0",
            ["build_property.UsingMicrosoftNETSdkWeb"] = req.UsingMicrosoftNetSdkWeb ? "true" : "",
            ["build_property.TargetFramework"] = req.Tfm ?? "net8.0",
            ["build_property.TargetFrameworkIdentifier"] = ".NETCoreApp",
            ["build_property.TargetFrameworkVersion"] = TfmToVersion(req.Tfm ?? "net8.0"),
            ["build_property.ProjectDir"] = (req.ProjectDir ?? "").TrimEnd('\\', '/') + System.IO.Path.DirectorySeparatorChar,
        };
        // Merge (don't clear) per-file specs so a previously-seen .cshtml keeps its
        // TargetPath even if a later request only carries a different file's spec.
        foreach (var f in req.Files ?? new())
            _perFile[PathKey(f.Path)] = new() { ["build_metadata.AdditionalFiles.TargetPath"] = f.TargetPathB64 };
    }

    private static string TfmToVersion(string tfm)
    {
        // net8.0 -> v8.0
        var digits = new string(tfm.SkipWhile(c => !char.IsDigit(c)).ToArray());
        return digits.Length > 0 ? "v" + digits : "v8.0";
    }

    /// The fully-sanitized hintName suffix expected for `path`'s generated source,
    /// derived from its `TargetPath` (e.g. `Views\Home\Index.cshtml` →
    /// `views_home_index_cshtml_g_cs`). `null` if no TargetPath is known for the
    /// file. Used by ReadGenerated to disambiguate same-stem views in subfolders/Areas.
    public string? SanitizedTargetSuffix(string path)
    {
        if (!_perFile.TryGetValue(PathKey(path), out var meta)) return null;
        if (!meta.TryGetValue("build_metadata.AdditionalFiles.TargetPath", out var b64)) return null;
        string targetPath;
        try
        {
            targetPath = Encoding.UTF8.GetString(Convert.FromBase64String(b64));
        }
        catch
        {
            return null;
        }
        // The generator names the source `<sanitized TargetPath>.g.cs`; sanitize the
        // whole thing (including `.g.cs`) so it lines up with Sanitize(hintName).
        return (targetPath.Replace('/', '_').Replace('\\', '_').Replace('.', '_') + "_g_cs")
            .ToLowerInvariant();
    }

    public override AnalyzerConfigOptions GlobalOptions => new Map(_globals);
    public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => new Map(_globals);
    public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) =>
        _perFile.TryGetValue(PathKey(textFile.Path), out var m) ? new Map(Merge(_globals, m)) : new Map(_globals);

    private static Dictionary<string, string> Merge(Dictionary<string, string> a, Dictionary<string, string> b)
    {
        var d = new Dictionary<string, string>(a);
        foreach (var kv in b) d[kv.Key] = kv.Value;
        return d;
    }

    private sealed class Map : AnalyzerConfigOptions
    {
        private readonly Dictionary<string, string> _m;
        public Map(Dictionary<string, string> m) => _m = m;
        public override bool TryGetValue(string key, out string value) => _m.TryGetValue(key, out value!);
    }
}

// ── Protocol DTOs ─────────────────────────────────────────────────────────────
record Request
{
    public long Id { get; init; }
    public string Kind { get; init; } = "";
    public string? ProjectDir { get; init; }
    public string? CshtmlPath { get; init; }
    public string? CshtmlText { get; init; }
    public string? ViewImportsPath { get; init; }
    public string? ViewImportsText { get; init; }
    public string? ViewStartPath { get; init; }
    public string? ViewStartText { get; init; }
    public List<string>? References { get; init; }
    public string? RootNamespace { get; init; }
    public string? RazorLangVersion { get; init; }
    public bool UsingMicrosoftNetSdkWeb { get; init; }
    public string? Tfm { get; init; }
    /// Per-file TargetPath (base64) for every AdditionalText, keyed by Path.
    public List<FileSpec>? Files { get; init; }
}

record FileSpec
{
    public string Path { get; init; } = "";
    public string TargetPathB64 { get; init; } = "";
    /// In-memory content for files the generator must read besides the edited
    /// target — the hierarchical `_ViewImports`/`_ViewStart` chain. Null for the
    /// target itself (its text arrives via the request's `CshtmlText`).
    public string? Text { get; init; }
}

record Response
{
    public long Id { get; init; }
    public bool Ok { get; init; }
    public string? GeneratedText { get; init; }
    public string? Error { get; init; }
}
