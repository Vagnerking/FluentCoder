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
        Console.InputEncoding = Encoding.UTF8;
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
        return new Response { Id = req.Id, Ok = true, GeneratedText = text };
    }

    private ProjectSession GetOrCreateSession(Request req)
    {
        string key = req.ProjectDir ?? "";
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
    // Live AdditionalText handles, keyed by absolute path, so we can ReplaceAdditionalText.
    private readonly Dictionary<string, AdditionalText> _texts = new(StringComparer.OrdinalIgnoreCase);
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
        // Order-insensitive stable hash of the reference set.
        unchecked
        {
            ulong h = 1469598103934665603UL;
            foreach (var r in refs.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
                foreach (char c in r) { h ^= c; h *= 1099511628211UL; }
            return h.ToString("x16");
        }
    }

    public static ProjectSession Create(Request req, string refsHash)
    {
        var generator = LoadRazorGenerator();
        var refs = (req.References ?? new())
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
        if (_texts.TryGetValue(path, out var old) && old.GetText()?.ToString() == text) return;
        var fresh = new InMemoryText(path, text);
        _driver = old is not null
            ? _driver.ReplaceAdditionalText(old, fresh)
            : _driver.AddAdditionalTexts(System.Collections.Immutable.ImmutableArray.Create<AdditionalText>(fresh));
        _texts[path] = fresh;
    }

    /// Re-emit `cshtmlPath` with `text`; returns the generated C#.
    public string Emit(string cshtmlPath, string text)
    {
        // A globals-only change (e.g. RootNamespace/TFM after a .csproj edit) needs
        // a fresh driver, or the incremental generator reuses stale output.
        RebuildDriverIfGlobalsChanged();
        if (_texts.TryGetValue(cshtmlPath, out var old) && old.GetText()?.ToString() == text)
        {
            // Unchanged — still run to fetch the cached output.
            _driver = _driver.RunGenerators(_compilation);
            return ReadGenerated(cshtmlPath);
        }
        var fresh = new InMemoryText(cshtmlPath, text);
        _driver = old is not null
            ? _driver.ReplaceAdditionalText(old, fresh)
            : _driver.AddAdditionalTexts(System.Collections.Immutable.ImmutableArray.Create<AdditionalText>(fresh));
        _texts[cshtmlPath] = fresh;
        _driver = _driver.RunGenerators(_compilation);
        return ReadGenerated(cshtmlPath);
    }

    private System.Collections.Immutable.ImmutableArray<AdditionalText> BuildAdditionalTexts(
        Request req, string? targetPath, string targetText)
    {
        var list = new List<AdditionalText>();
        void add(string? path, string? text)
        {
            if (path is null || text is null) return;
            var t = new InMemoryText(path, text);
            _texts[path] = t;
            list.Add(t);
        }
        add(req.ViewImportsPath, req.ViewImportsText);
        add(req.ViewStartPath, req.ViewStartText);
        if (targetPath is not null) add(targetPath, targetText);
        return System.Collections.Immutable.ImmutableArray.CreateRange(list);
    }

    private string ReadGenerated(string cshtmlPath)
    {
        string wantSuffix = Path.GetFileName(cshtmlPath).Replace('.', '_') + ".g.cs";
        var result = _driver.GetRunResult();
        foreach (var gen in result.Results)
            foreach (var src in gen.GeneratedSources)
                if (src.HintName.EndsWith(wantSuffix, StringComparison.OrdinalIgnoreCase))
                    return src.SourceText.ToString();
        // Fallback: a contains-match on the stem, else the first source.
        string stem = Path.GetFileNameWithoutExtension(cshtmlPath);
        foreach (var gen in result.Results)
            foreach (var src in gen.GeneratedSources)
                if (src.HintName.Contains(stem, StringComparison.OrdinalIgnoreCase))
                    return src.SourceText.ToString();
        return "";
    }

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
    private static string ResolveRazorCompilerDll()
    {
        // Allow an explicit override (the Rust host can pass the exact SDK path).
        string? overridePath = Environment.GetEnvironmentVariable("RAZOR_COMPILER_DLL");
        if (!string.IsNullOrEmpty(overridePath) && File.Exists(overridePath)) return overridePath;

        string sdksRoot = Path.Combine(
            Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files",
            "dotnet", "sdk");
        if (!Directory.Exists(sdksRoot))
            throw new Exception($"dotnet sdk dir not found: {sdksRoot}");

        var candidates = Directory.GetDirectories(sdksRoot)
            .Select(d => Path.Combine(d,
                "Sdks", "Microsoft.NET.Sdk.Razor", "source-generators",
                "Microsoft.CodeAnalysis.Razor.Compiler.dll"))
            .Where(File.Exists)
            .ToList();
        if (candidates.Count == 0)
            throw new Exception($"no Razor.Compiler.dll under {sdksRoot}");
        // Prefer 8.0.x (matches the pinned Roslyn 4.9.x); else newest.
        var pinned = candidates.FirstOrDefault(p => p.Contains(@"\8.0.", StringComparison.OrdinalIgnoreCase));
        return pinned ?? candidates.OrderByDescending(p => p).First();
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
            _perFile[f.Path] = new() { ["build_metadata.AdditionalFiles.TargetPath"] = f.TargetPathB64 };
    }

    private static string TfmToVersion(string tfm)
    {
        // net8.0 -> v8.0
        var digits = new string(tfm.SkipWhile(c => !char.IsDigit(c)).ToArray());
        return digits.Length > 0 ? "v" + digits : "v8.0";
    }

    public override AnalyzerConfigOptions GlobalOptions => new Map(_globals);
    public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => new Map(_globals);
    public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) =>
        _perFile.TryGetValue(textFile.Path, out var m) ? new Map(Merge(_globals, m)) : new Map(_globals);

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
}

record Response
{
    public long Id { get; init; }
    public bool Ok { get; init; }
    public string? GeneratedText { get; init; }
    public string? Error { get; init; }
}
