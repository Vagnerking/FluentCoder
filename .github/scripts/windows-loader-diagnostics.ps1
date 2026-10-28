param([string]$BinaryDirectory = "src-tauri/target/debug/deps")

# Read-only diagnostics for failures before the Rust test harness starts.
# Keep the original test failure; this step only exposes native imports and
# the DLL candidates on the runner, without changing PATH or replacing DLLs.
$ErrorActionPreference = "Stop"
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
$installation = & $vswhere -latest -products '*' -property installationPath
$dumpbin = Get-ChildItem "$installation/VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe" |
    Sort-Object FullName -Descending | Select-Object -First 1
if (!$dumpbin) { throw "dumpbin.exe not found" }
$binaries = @(Get-ChildItem "$BinaryDirectory/fluent_coder_lib-*.exe")
if (!$binaries.Count) { throw "Rust test executable not found" }
foreach ($binary in $binaries) {
    Write-Output "Native imports: $($binary.FullName)"
    $imports = & $dumpbin.FullName /IMPORTS $binary.FullName
    if ($LASTEXITCODE -ne 0) { throw "dumpbin failed: $LASTEXITCODE" }
    $imports | Write-Output
    $libraries = $imports | Select-String '^\s+([a-zA-Z0-9_.-]+\.dll)\s*$' |
        ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique
    $directories = @($binary.DirectoryName, "$env:SystemRoot/System32", $env:SystemRoot) +
        @($env:PATH -split ';' | Where-Object { $_ })
    foreach ($library in $libraries) {
        Write-Output "DLL candidates in executable/system/PATH directories: $library"
        foreach ($directory in ($directories | Select-Object -Unique)) {
            $candidate = Join-Path $directory $library
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $file = Get-Item -LiteralPath $candidate
                Write-Output "$($file.FullName) version=$($file.VersionInfo.FileVersion)"
            }
        }
    }
}
