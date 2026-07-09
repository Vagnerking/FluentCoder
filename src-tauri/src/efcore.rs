//! EF Core tools (issue #97): migrations e DbContext via `dotnet ef`.
//!
//! Segue o padrão de `dotnet_tools.rs`/`testrunner.rs`: commands async com
//! `spawn_blocking`, CLI em inglês (`DOTNET_CLI_UI_LANGUAGE=en`) e sem flash de
//! console no Windows (via `dotnet_tools::dotnet_command`). A leitura de dados
//! usa `--json` (locale-estável); como o dotnet-ef imprime linhas de log ANTES
//! do payload (ex.: "Build started..."), o parser localiza o início do JSON.
//!
//! Fora deste corte: scaffold de banco (`dotnet ef dbcontext scaffold`) — fluxo
//! interativo com connection string; fica como follow-up.

use crate::dotnet_tools::{dotnet_command, tail, DotnetActionResult};

// ── Funções puras (testáveis) ───────────────────────────────────────────────

/// True quando o XML do `.csproj` referencia EF Core: algum `<PackageReference>`
/// cujo `Include` começa com `Microsoft.EntityFrameworkCore` (case-insensitive,
/// como o NuGet trata ids). Scan leve, sem crate XML — padrão do repo.
pub(crate) fn csproj_uses_efcore(xml: &str) -> bool {
    let lower = xml.to_ascii_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find("<packagereference") {
        let start = from + pos;
        // Delimita a tag (até `>`); sem `>` o arquivo está truncado — para aqui.
        let Some(end_rel) = lower[start..].find('>') else { return false };
        let tag = &lower[start..start + end_rel];
        if let Some(include) = attribute_value(tag, "include") {
            if include.trim().starts_with("microsoft.entityframeworkcore") {
                return true;
            }
        }
        from = start + end_rel;
    }
    false
}

/// Valor do atributo `name="…"` (ou aspas simples) dentro de `tag` já em
/// minúsculas. Tolera espaços em volta do `=`.
fn attribute_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(pos) = tag[from..].find(name) {
        let abs = from + pos;
        // Precisa ser um atributo (precedido de espaço), não parte de outro nome.
        let prev_ok = tag[..abs].chars().last().map_or(true, |c| c.is_whitespace());
        let rest = &tag[abs + name.len()..];
        let after_eq = rest.trim_start();
        if prev_ok && after_eq.starts_with('=') {
            let val = after_eq[1..].trim_start();
            let quote = val.chars().next()?;
            if quote == '"' || quote == '\'' {
                let inner = &val[1..];
                if let Some(close) = inner.find(quote) {
                    return Some(&inner[..close]);
                }
            }
            return None;
        }
        from = abs + name.len();
    }
    None
}

/// Extrai o payload JSON da saída do `dotnet ef … --json`: o dotnet-ef imprime
/// linhas de log antes (ex.: "Build started..."), então o JSON começa na
/// primeira LINHA cujo primeiro caractere é `[` ou `{` e vai até o fim do
/// último `]`/`}` (depois pode vir mais log em alguns SDKs).
pub(crate) fn extract_json(output: &str) -> Option<&str> {
    let mut start: Option<usize> = None;
    let mut offset = 0;
    for line in output.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') || trimmed.starts_with('{') {
            start = Some(offset + (line.len() - trimmed.len()));
            break;
        }
        offset += line.len();
    }
    let start = start?;
    let end = output.rfind([']', '}'])?;
    if end < start {
        return None;
    }
    Some(&output[start..=end])
}

/// Uma migration como reportada por `dotnet ef migrations list --json`.
/// `applied` é `None` quando o EF não conseguiu conectar ao banco para saber.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EfMigration {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub safe_name: String,
    #[serde(default)]
    pub applied: Option<bool>,
}

/// Parseia a saída de `dotnet ef migrations list --json` (com lixo de log antes
/// do array). Array ausente/saída sem JSON ⇒ erro com a cauda da saída.
pub(crate) fn parse_migrations_json(output: &str) -> Result<Vec<EfMigration>, String> {
    let json = extract_json(output)
        .ok_or_else(|| format!("Saída sem JSON do dotnet ef: {}", tail(output, 400)))?;
    serde_json::from_str(json).map_err(|e| e.to_string())
}

/// Um DbContext como reportado por `dotnet ef dbcontext list --json`.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EfDbContext {
    #[serde(default)]
    pub full_name: String,
    #[serde(default)]
    pub safe_name: String,
    #[serde(default)]
    pub name: String,
}

/// Parseia a saída de `dotnet ef dbcontext list --json`.
pub(crate) fn parse_dbcontexts_json(output: &str) -> Result<Vec<EfDbContext>, String> {
    let json = extract_json(output)
        .ok_or_else(|| format!("Saída sem JSON do dotnet ef: {}", tail(output, 400)))?;
    serde_json::from_str(json).map_err(|e| e.to_string())
}

/// Versão da tool a partir do stdout de `dotnet ef --version`: a última linha
/// não vazia (a primeira é o banner "Entity Framework Core .NET Command-line Tools").
pub(crate) fn parse_ef_version(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .next_back()
        .map(str::to_string)
}

/// Nome de migration válido: identificador C#-like (letra/underscore inicial,
/// depois alfanumérico/underscore). Evita injetar flags/paths no CLI.
pub(crate) fn is_valid_migration_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || c == '_')
}

// ── Execução do dotnet ef ───────────────────────────────────────────────────

/// Roda `dotnet ef <args…> --project <csproj>` capturando stdout+stderr.
/// Retorna (sucesso, saída combinada).
async fn run_dotnet_ef(csproj_path: String, args: Vec<String>) -> Result<(bool, String), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = dotnet_command();
        cmd.arg("ef");
        for a in &args {
            cmd.arg(a);
        }
        if !csproj_path.is_empty() {
            cmd.arg("--project").arg(&csproj_path);
        }
        let out = cmd
            .output()
            .map_err(|e| format!("Não foi possível executar o dotnet (o .NET SDK está instalado?): {e}"))?;
        let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
        let err = String::from_utf8_lossy(&out.stderr);
        if !err.trim().is_empty() {
            combined.push('\n');
            combined.push_str(&err);
        }
        Ok((out.status.success(), combined))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Commands Tauri ──────────────────────────────────────────────────────────

/// True quando o `.csproj` referencia EF Core (PackageReference
/// `Microsoft.EntityFrameworkCore*`). Leitura + scan puro, fora do reactor.
#[tauri::command]
pub async fn efcore_detect(csproj_path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let xml = std::fs::read_to_string(&csproj_path).map_err(|e| e.to_string())?;
        Ok(csproj_uses_efcore(&xml))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Versão do dotnet-ef (`dotnet ef --version`), ou `None` quando a tool não
/// está instalada/acessível (a UI então oferece a instalação).
#[tauri::command]
pub async fn efcore_tool_version() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = dotnet_command().args(["ef", "--version"]).output();
        match out {
            Ok(o) if o.status.success() => {
                Ok(parse_ef_version(&String::from_utf8_lossy(&o.stdout)))
            }
            // dotnet ausente ou `ef` desconhecido ⇒ tool indisponível (não é erro).
            _ => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Instala a tool global: `dotnet tool install --global dotnet-ef`.
#[tauri::command]
pub async fn efcore_tool_install() -> Result<DotnetActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = dotnet_command()
            .args(["tool", "install", "--global", "dotnet-ef"])
            .output()
            .map_err(|e| format!("Não foi possível executar o dotnet (o .NET SDK está instalado?): {e}"))?;
        let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
        let err = String::from_utf8_lossy(&out.stderr);
        if !err.trim().is_empty() {
            combined.push('\n');
            combined.push_str(&err);
        }
        Ok(DotnetActionResult {
            success: out.status.success(),
            output: tail(&combined, 4000),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `dotnet ef migrations list --json` do projeto. Falha ⇒ erro com a cauda da
/// saída (ex.: projeto sem DbContext, build quebrado).
#[tauri::command]
pub async fn efcore_migrations_list(csproj_path: String) -> Result<Vec<EfMigration>, String> {
    let (ok, output) = run_dotnet_ef(
        csproj_path,
        vec!["migrations".into(), "list".into(), "--json".into()],
    )
    .await?;
    if !ok {
        return Err(tail(&output, 2000));
    }
    parse_migrations_json(&output)
}

/// `dotnet ef migrations add <nome>`. O nome é validado (identificador) antes
/// de tocar o CLI.
#[tauri::command]
pub async fn efcore_migrations_add(
    csproj_path: String,
    name: String,
) -> Result<DotnetActionResult, String> {
    if !is_valid_migration_name(&name) {
        return Err("Nome de migration inválido: use letras, números e _ (começando com letra).".into());
    }
    let (ok, output) = run_dotnet_ef(
        csproj_path,
        vec!["migrations".into(), "add".into(), name],
    )
    .await?;
    Ok(DotnetActionResult { success: ok, output: tail(&output, 4000) })
}

/// `dotnet ef database update` — aplica as migrations pendentes no banco.
#[tauri::command]
pub async fn efcore_database_update(csproj_path: String) -> Result<DotnetActionResult, String> {
    let (ok, output) = run_dotnet_ef(csproj_path, vec!["database".into(), "update".into()]).await?;
    Ok(DotnetActionResult { success: ok, output: tail(&output, 4000) })
}

/// `dotnet ef dbcontext list --json` — DbContexts do projeto.
#[tauri::command]
pub async fn efcore_dbcontext_list(csproj_path: String) -> Result<Vec<EfDbContext>, String> {
    let (ok, output) = run_dotnet_ef(
        csproj_path,
        vec!["dbcontext".into(), "list".into(), "--json".into()],
    )
    .await?;
    if !ok {
        return Err(tail(&output, 2000));
    }
    parse_dbcontexts_json(&output)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- csproj_uses_efcore ----

    #[test]
    fn detects_efcore_package_reference() {
        let xml = r#"<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.0" />
  </ItemGroup>
</Project>"#;
        assert!(csproj_uses_efcore(xml));
    }

    #[test]
    fn detects_efcore_base_package_and_design() {
        let base = r#"<PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />"#;
        let design = r#"<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.0"><PrivateAssets>all</PrivateAssets></PackageReference>"#;
        assert!(csproj_uses_efcore(base));
        assert!(csproj_uses_efcore(design));
    }

    #[test]
    fn detection_is_case_insensitive_and_tolerates_spacing() {
        assert!(csproj_uses_efcore(
            r#"<packagereference include = 'microsoft.entityframeworkcore.sqlite' version='9.0.0'/>"#
        ));
        assert!(csproj_uses_efcore(
            "<PackageReference\n    Include=\"Microsoft.EntityFrameworkCore\"\n    Version=\"8.0.0\" />"
        ));
    }

    #[test]
    fn ignores_non_efcore_packages() {
        let xml = r#"<Project>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.4" />
    <PackageReference Include="Microsoft.Extensions.Logging" Version="8.0.0" />
  </ItemGroup>
</Project>"#;
        assert!(!csproj_uses_efcore(xml));
    }

    #[test]
    fn ignores_efcore_substring_not_in_include_attr() {
        // "EntityFrameworkCore" em outro lugar (comentário/Version) não conta.
        let xml = r#"<Project>
  <!-- usa Microsoft.EntityFrameworkCore em outro projeto -->
  <ItemGroup>
    <PackageReference Include="Dapper" Version="2.1.0" />
  </ItemGroup>
</Project>"#;
        assert!(!csproj_uses_efcore(xml));
        // Prefixo diferente também não ("MyMicrosoft.EntityFrameworkCore" nunca existe,
        // mas garante o starts_with).
        assert!(!csproj_uses_efcore(
            r#"<PackageReference Include="NotMicrosoft.EntityFrameworkCore" />"#
        ));
    }

    #[test]
    fn empty_or_truncated_csproj_is_not_efcore() {
        assert!(!csproj_uses_efcore(""));
        assert!(!csproj_uses_efcore("<PackageReference Include=\"Microsoft.EntityFrameworkCore\""));
    }

    // ---- extract_json / parsers ----

    const MIGRATIONS_OUTPUT: &str = "Build started...\nBuild succeeded.\n[\n  {\n    \"id\": \"20240101000000_Initial\",\n    \"name\": \"Initial\",\n    \"safeName\": \"Initial\",\n    \"applied\": true\n  },\n  {\n    \"id\": \"20240202000000_AddOrders\",\n    \"name\": \"AddOrders\",\n    \"safeName\": \"AddOrders\",\n    \"applied\": false\n  }\n]\n";

    #[test]
    fn parses_migrations_with_log_noise_before_json() {
        let m = parse_migrations_json(MIGRATIONS_OUTPUT).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "20240101000000_Initial");
        assert_eq!(m[0].applied, Some(true));
        assert_eq!(m[1].name, "AddOrders");
        assert_eq!(m[1].applied, Some(false));
    }

    #[test]
    fn parses_empty_migrations_array() {
        let m = parse_migrations_json("Build started...\nBuild succeeded.\n[]\n").unwrap();
        assert!(m.is_empty());
    }

    #[test]
    fn migration_applied_defaults_to_none_when_absent() {
        // Sem conexão com o banco o EF pode omitir `applied`.
        let out = "Build succeeded.\n[ { \"id\": \"20240101000000_Initial\", \"name\": \"Initial\", \"safeName\": \"Initial\" } ]";
        let m = parse_migrations_json(out).unwrap();
        assert_eq!(m[0].applied, None);
    }

    #[test]
    fn output_without_json_is_an_error() {
        assert!(parse_migrations_json("Build started...\nBuild FAILED.\n").is_err());
        assert!(parse_dbcontexts_json("No project was found.").is_err());
    }

    #[test]
    fn extract_json_requires_line_start_bracket() {
        // `[` no meio de uma linha de log não é o payload.
        let out = "warn [build]: algo\n[\n  { \"id\": \"1_a\", \"name\": \"a\", \"safeName\": \"a\" }\n]";
        let json = extract_json(out).unwrap();
        assert!(json.starts_with("[\n"));
        assert!(json.ends_with(']'));
    }

    #[test]
    fn extract_json_handles_trailing_log_after_payload() {
        let out = "Build succeeded.\n[]\nDone.";
        // rfind de ']' ignora o log posterior sem colchetes.
        assert_eq!(extract_json(out), Some("[]"));
    }

    #[test]
    fn parses_dbcontext_list() {
        let out = "Build started...\nBuild succeeded.\n[\n  {\n    \"fullName\": \"Loja.Data.AppDbContext\",\n    \"safeName\": \"Loja.Data.AppDbContext\",\n    \"name\": \"AppDbContext\",\n    \"assemblyQualifiedName\": \"Loja.Data.AppDbContext, Loja\"\n  }\n]";
        let ctxs = parse_dbcontexts_json(out).unwrap();
        assert_eq!(ctxs.len(), 1);
        assert_eq!(ctxs[0].full_name, "Loja.Data.AppDbContext");
        assert_eq!(ctxs[0].name, "AppDbContext");
    }

    // ---- versão / nome ----

    #[test]
    fn parses_ef_version_banner() {
        let out = "Entity Framework Core .NET Command-line Tools\n8.0.11\n";
        assert_eq!(parse_ef_version(out).as_deref(), Some("8.0.11"));
        assert_eq!(parse_ef_version("").as_deref(), None);
    }

    #[test]
    fn validates_migration_names() {
        assert!(is_valid_migration_name("AddOrders"));
        assert!(is_valid_migration_name("_Interna2"));
        assert!(!is_valid_migration_name(""));
        assert!(!is_valid_migration_name("2Fast"));
        assert!(!is_valid_migration_name("Add Orders"));
        assert!(!is_valid_migration_name("--force"));
        assert!(!is_valid_migration_name("a;rm -rf"));
    }
}
