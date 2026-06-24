// Spike (Etapa 1): run the REAL Razor source generator on in-memory .cshtml text
// via CSharpGeneratorDriver, measure cold/warm latency, and compare the emitted
// .g.cs against the golden file `dotnet build` produced. See SidecarSpike.csproj.
//
// Usage: dotnet run -c Release  (run from this folder)

using System.Diagnostics;
using System.Reflection;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

// ── Inputs (the SampleMvc fixture; SDK/ref paths resolved from the active dotnet) ─
string fixture = Path.GetFullPath(Path.Combine(
    AppContext.BaseDirectory, "..", "..", "..", "..", "fixtures", "SampleMvc"));
string generatorDll = ResolveRazorGeneratorDll();

string indexPath = Path.Combine(fixture, "Views", "Home", "Index.cshtml");
string viewImportsPath = Path.Combine(fixture, "Views", "_ViewImports.cshtml");
string viewStartPath = Path.Combine(fixture, "Views", "_ViewStart.cshtml");
string golden = Path.Combine(fixture, "obj", "Debug", "net8.0", "generated",
    "Microsoft.CodeAnalysis.Razor.Compiler",
    "Microsoft.NET.Sdk.Razor.SourceGenerators.RazorSourceGenerator",
    "Views", "Home", "Index_cshtml.g.cs");

Console.WriteLine($"fixture       = {fixture}");
Console.WriteLine($"generator dll = {generatorDll}  exists={File.Exists(generatorDll)}");
Console.WriteLine($"golden        = {golden}  exists={File.Exists(golden)}");

// ── Load the Razor source generator by reflection ────────────────────────────
Assembly gasm = Assembly.LoadFrom(generatorDll);
Type genType = gasm.GetType(
    "Microsoft.NET.Sdk.Razor.SourceGenerators.RazorSourceGenerator")
    ?? throw new Exception("RazorSourceGenerator type not found");
var generator = (IIncrementalGenerator)Activator.CreateInstance(genType)!;
Console.WriteLine($"generator     = {genType.FullName}");

// ── AdditionalTexts (the three .cshtml) ──────────────────────────────────────
AdditionalText index = new InMemoryText(indexPath, File.ReadAllText(indexPath));
AdditionalText viewImports = new InMemoryText(viewImportsPath, File.ReadAllText(viewImportsPath));
AdditionalText viewStart = new InMemoryText(viewStartPath, File.ReadAllText(viewStartPath));
var additionalTexts = ImmutableArrayOf(index, viewImports, viewStart);

// ── AnalyzerConfigOptions: the editorconfig contract the generator reads ──────
var globals = new Dictionary<string, string>
{
    ["build_property.RootNamespace"] = "SampleMvc",
    ["build_property.RazorLangVersion"] = "8.0",
    ["build_property.UsingMicrosoftNETSdkWeb"] = "true",
    ["build_property.TargetFramework"] = "net8.0",
    ["build_property.TargetFrameworkIdentifier"] = ".NETCoreApp",
    ["build_property.TargetFrameworkVersion"] = "v8.0",
    ["build_property.ProjectDir"] = fixture + Path.DirectorySeparatorChar,
};
var perFile = new Dictionary<string, Dictionary<string, string>>
{
    [index.Path] = new() { ["build_metadata.AdditionalFiles.TargetPath"] = B64(@"Views\Home\Index.cshtml") },
    [viewImports.Path] = new() { ["build_metadata.AdditionalFiles.TargetPath"] = B64(@"Views\_ViewImports.cshtml") },
    [viewStart.Path] = new() { ["build_metadata.AdditionalFiles.TargetPath"] = B64(@"Views\_ViewStart.cshtml") },
};
var optionsProvider = new SpikeOptionsProvider(globals, perFile);

// ── Compilation with the framework references (TagHelpers come from these) ────
var refs = ResolveAspNetCoreRefs();
Console.WriteLine($"references    = {refs.Count} assemblies");
var compilation = CSharpCompilation.Create(
    "ShadowRazor",
    syntaxTrees: Array.Empty<Microsoft.CodeAnalysis.SyntaxTree>(),
    references: refs,
    options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);

GeneratorDriver driver = CSharpGeneratorDriver.Create(
    generators: new[] { generator.AsSourceGenerator() },
    additionalTexts: additionalTexts,
    parseOptions: parseOptions,
    optionsProvider: optionsProvider);

// ── COLD run ─────────────────────────────────────────────────────────────────
var sw = Stopwatch.StartNew();
driver = driver.RunGenerators(compilation);
sw.Stop();
long coldMs = sw.ElapsedMilliseconds;
string emitted = ReadGenerated(driver, "Index_cshtml.g.cs");
Console.WriteLine($"\nCOLD run      = {coldMs} ms   (emitted {emitted.Length} chars)");

// ── WARM runs: change ONLY Index.cshtml's text, reuse the driver ─────────────
var warmTimes = new List<long>();
string baseText = File.ReadAllText(indexPath);
for (int i = 0; i < 5; i++)
{
    // Simulate a keystroke: replace the index AdditionalText content.
    var edited = new InMemoryText(indexPath, baseText + new string(' ', i + 1));
    driver = driver.ReplaceAdditionalText(index, edited);
    index = edited;
    sw.Restart();
    driver = driver.RunGenerators(compilation);
    sw.Stop();
    warmTimes.Add(sw.ElapsedMilliseconds);
}
Console.WriteLine($"WARM runs     = [{string.Join(", ", warmTimes)}] ms   (median {Median(warmTimes)} ms)");

// ── Compare COLD emission to the golden (structural, ignoring CRLF/whitespace) ─
if (File.Exists(golden))
{
    string goldenText = File.ReadAllText(golden);
    bool exact = Normalize(emitted) == Normalize(goldenText);
    Console.WriteLine($"\nGOLDEN match  = {(exact ? "EXACT (normalized)" : "DIFFERENT")}");
    if (!exact)
    {
        // Show the first differing line to diagnose.
        var a = Normalize(emitted).Split('\n');
        var b = Normalize(goldenText).Split('\n');
        for (int i = 0; i < Math.Min(a.Length, b.Length); i++)
        {
            if (a[i] != b[i])
            {
                Console.WriteLine($"  first diff @ line {i}:");
                Console.WriteLine($"    spike : {a[i]}");
                Console.WriteLine($"    golden: {b[i]}");
                break;
            }
        }
        Console.WriteLine($"  spike lines={a.Length} golden lines={b.Length}");
        // Key fidelity checks regardless of exactness:
        Console.WriteLine($"  has #line maps : {emitted.Contains("#line (")}");
        Console.WriteLine($"  has RazorPage  : {emitted.Contains("RazorPage<")}");
        Console.WriteLine($"  has Model.City : {emitted.Contains("Model.City")}");
        Console.WriteLine($"  has TagHelper  : {emitted.Contains("TagHelper")}");
    }
}

Console.WriteLine("\n--- spike done ---");

// ── Helpers ──────────────────────────────────────────────────────────────────
static string B64(string s) => Convert.ToBase64String(Encoding.UTF8.GetBytes(s));

static string Normalize(string s) =>
    string.Join('\n', s.Replace("\r\n", "\n").Split('\n').Select(l => l.TrimEnd()))
          .Trim();

static long Median(List<long> xs)
{
    var s = xs.OrderBy(x => x).ToList();
    return s[s.Count / 2];
}

static string ReadGenerated(GeneratorDriver driver, string fileNameSuffix)
{
    var result = driver.GetRunResult();
    foreach (var gen in result.Results)
        foreach (var src in gen.GeneratedSources)
            if (src.HintName.EndsWith(fileNameSuffix, StringComparison.OrdinalIgnoreCase)
                || src.HintName.Contains("Index_cshtml"))
                return src.SourceText.ToString();
    // Fallback: any generated source.
    foreach (var gen in result.Results)
        foreach (var src in gen.GeneratedSources)
            return src.SourceText.ToString();
    return "";
}

static System.Collections.Immutable.ImmutableArray<AdditionalText> ImmutableArrayOf(
    params AdditionalText[] items) =>
    System.Collections.Immutable.ImmutableArray.Create(items);

// Resolve the ASP.NET Core + base framework reference assemblies (the ref packs)
// from the ACTIVE dotnet install rather than a hardcoded Program Files path.
static List<MetadataReference> ResolveAspNetCoreRefs()
{
    var refs = new List<MetadataReference>();
    string? dotnetRoot = FindDotnetRoot();
    if (dotnetRoot is null) return refs;
    string packs = Path.Combine(dotnetRoot, "packs");
    foreach (var pack in new[] { "Microsoft.AspNetCore.App.Ref", "Microsoft.NETCore.App.Ref" })
    {
        string baseDir = Path.Combine(packs, pack);
        if (!Directory.Exists(baseDir)) continue;
        // newest 8.0.* version
        var ver = Directory.GetDirectories(baseDir)
            .Select(Path.GetFileName)
            .Where(v => v!.StartsWith("8.0"))
            .OrderByDescending(v => v)
            .FirstOrDefault();
        if (ver is null) continue;
        string refDir = Directory.GetDirectories(Path.Combine(baseDir, ver, "ref"))
            .OrderByDescending(d => d).First();
        foreach (var dll in Directory.GetFiles(refDir, "*.dll"))
            refs.Add(MetadataReference.CreateFromFile(dll));
    }
    return refs;
}

// Locate the Razor source generator DLL under the active SDK (prefer 8.0.x),
// instead of assuming `C:\Program Files\dotnet\sdk\8.0.421`. Honors an env override.
static string ResolveRazorGeneratorDll()
{
    string? overridePath = Environment.GetEnvironmentVariable("RAZOR_COMPILER_DLL");
    if (!string.IsNullOrEmpty(overridePath) && File.Exists(overridePath)) return overridePath;

    string? dotnetRoot = FindDotnetRoot();
    if (dotnetRoot is null) throw new Exception("could not locate a dotnet install (set DOTNET_ROOT or RAZOR_COMPILER_DLL)");
    string sdksRoot = Path.Combine(dotnetRoot, "sdk");
    if (!Directory.Exists(sdksRoot)) throw new Exception($"no sdk dir under {dotnetRoot}");

    var candidates = Directory.GetDirectories(sdksRoot)
        .Select(d => Path.Combine(d, "Sdks", "Microsoft.NET.Sdk.Razor",
            "source-generators", "Microsoft.CodeAnalysis.Razor.Compiler.dll"))
        .Where(File.Exists)
        .ToList();
    if (candidates.Count == 0) throw new Exception($"no Razor.Compiler.dll under {sdksRoot}");
    var pinned = candidates.FirstOrDefault(p =>
        p.Contains($"{Path.DirectorySeparatorChar}8.0.", StringComparison.OrdinalIgnoreCase) ||
        p.Contains("/8.0.", StringComparison.OrdinalIgnoreCase));
    return pinned ?? candidates.OrderByDescending(p => p).First();
}

// The active dotnet root: DOTNET_ROOT, else the running runtime's root, else OS default.
static string? FindDotnetRoot()
{
    string? env = Environment.GetEnvironmentVariable("DOTNET_ROOT")
                  ?? Environment.GetEnvironmentVariable("DOTNET_ROOT(x64)");
    if (!string.IsNullOrEmpty(env) && Directory.Exists(env)) return env;

    // Runtime lives at <root>/shared/Microsoft.NETCore.App/<ver>; walk up to <root>.
    string runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
    string? root = Directory.GetParent(runtimeDir.TrimEnd(Path.DirectorySeparatorChar))?.Parent?.Parent?.FullName;
    if (root is not null && Directory.Exists(Path.Combine(root, "sdk"))) return root;

    if (OperatingSystem.IsWindows())
    {
        string pf = Path.Combine(
            Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files", "dotnet");
        if (Directory.Exists(pf)) return pf;
    }
    else
    {
        foreach (var r in new[] { "/usr/lib/dotnet", "/usr/share/dotnet", "/usr/local/share/dotnet" })
            if (Directory.Exists(r)) return r;
    }
    return null;
}

// ── In-memory AdditionalText ─────────────────────────────────────────────────
sealed class InMemoryText(string path, string text) : AdditionalText
{
    private readonly SourceText _text = SourceText.From(text, Encoding.UTF8);
    public override string Path { get; } = path;
    public override SourceText GetText(CancellationToken cancellationToken = default) => _text;
}

// ── Options provider returning the editorconfig contract ─────────────────────
sealed class SpikeOptionsProvider(
    Dictionary<string, string> globals,
    Dictionary<string, Dictionary<string, string>> perFile) : AnalyzerConfigOptionsProvider
{
    public override AnalyzerConfigOptions GlobalOptions { get; } = new MapOptions(globals);
    public override AnalyzerConfigOptions GetOptions(Microsoft.CodeAnalysis.SyntaxTree tree) =>
        new MapOptions(globals);
    public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) =>
        perFile.TryGetValue(textFile.Path, out var m)
            ? new MapOptions(Merge(globals, m))
            : new MapOptions(globals);

    static Dictionary<string, string> Merge(Dictionary<string, string> a, Dictionary<string, string> b)
    {
        var d = new Dictionary<string, string>(a);
        foreach (var kv in b) d[kv.Key] = kv.Value;
        return d;
    }

    sealed class MapOptions(Dictionary<string, string> map) : AnalyzerConfigOptions
    {
        public override bool TryGetValue(string key, out string value) =>
            map.TryGetValue(key, out value!);
    }
}

// (extra) write the spike output for inspection
