use crate::child_process::hide_console_window;
use crate::walk::is_skipped_dir;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "lowercase")]
pub enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManager {
    pub(crate) fn command(self) -> &'static str {
        match self {
            PackageManager::Npm => "npm",
            PackageManager::Pnpm => "pnpm",
            PackageManager::Yarn => "yarn",
            PackageManager::Bun => "bun",
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageLockfile {
    pub name: String,
    pub path: String,
    pub manager: PackageManager,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageManagerRecommendation {
    pub manager: PackageManager,
    pub confidence: RecommendationConfidence,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RecommendationConfidence {
    High,
    Medium,
    Low,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DependencyBuckets {
    pub dependencies: usize,
    pub dev_dependencies: usize,
    pub peer_dependencies: usize,
    pub optional_dependencies: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageDependency {
    pub name: String,
    pub declared_version: String,
    pub kind: DependencyKind,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum DependencyKind {
    Dependencies,
    DevDependencies,
    PeerDependencies,
    OptionalDependencies,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageOutdatedDependency {
    pub name: String,
    pub current: Option<String>,
    pub wanted: Option<String>,
    pub latest: Option<String>,
    pub declared_version: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageCommandResult {
    pub project_path: String,
    pub manager: PackageManager,
    pub command: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageOutdatedReport {
    #[serde(flatten)]
    pub command: PackageCommandResult,
    pub outdated: Vec<PackageOutdatedDependency>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageAuditReport {
    #[serde(flatten)]
    pub command: PackageCommandResult,
    pub summary: AuditSummary,
    pub vulnerabilities: Vec<PackageAuditVulnerability>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageVersionsReport {
    #[serde(flatten)]
    pub command: PackageCommandResult,
    pub package_name: String,
    pub versions: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditSummary {
    pub total: usize,
    pub low: usize,
    pub moderate: usize,
    pub high: usize,
    pub critical: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageAuditVulnerability {
    pub package: String,
    pub severity: String,
    pub title: String,
    pub url: Option<String>,
    pub range: Option<String>,
    pub fix_available: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JsTsPackageProject {
    pub name: String,
    pub path: String,
    pub dir: String,
    pub relative_dir: String,
    pub declared_package_manager: Option<String>,
    pub detected_manager: PackageManagerRecommendation,
    pub lockfiles: Vec<PackageLockfile>,
    pub scripts: Vec<String>,
    pub dependencies: Vec<PackageDependency>,
    pub dependency_counts: DependencyBuckets,
    pub has_workspaces: bool,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageWorkspaceSummary {
    pub root: String,
    pub projects: Vec<JsTsPackageProject>,
    pub manager_counts: BTreeMap<String, usize>,
    pub warning_count: usize,
}

#[tauri::command]
pub fn package_intel_scan(root: String) -> Result<PackageWorkspaceSummary, String> {
    scan_package_workspace(Path::new(&root))
}

#[tauri::command]
pub fn package_intel_outdated(
    root: String,
    project_path: String,
    manager: PackageManager,
) -> Result<PackageOutdatedReport, String> {
    let root = canonical_root(&root)?;
    let package_json = resolve_project_manifest(&root, &project_path)?;
    let dir = package_json.parent().unwrap_or(&root);
    let declared = read_declared_dependency_versions(&package_json)?;
    let command_result = run_package_command(dir, manager, PackageCommandKind::Outdated)?;
    Ok(outdated_report_from_command(command_result, &declared))
}

#[tauri::command]
pub fn package_intel_audit(
    root: String,
    project_path: String,
    manager: PackageManager,
) -> Result<PackageAuditReport, String> {
    let root = canonical_root(&root)?;
    let package_json = resolve_project_manifest(&root, &project_path)?;
    let dir = package_json.parent().unwrap_or(&root);
    let command_result = run_package_command(dir, manager, PackageCommandKind::Audit)?;
    Ok(audit_report_from_command(command_result))
}

#[tauri::command]
pub fn package_intel_versions(
    root: String,
    project_path: String,
    manager: PackageManager,
    package_name: String,
) -> Result<PackageVersionsReport, String> {
    let root = canonical_root(&root)?;
    let package_json = resolve_project_manifest(&root, &project_path)?;
    let dir = package_json.parent().unwrap_or(&root);
    let command_result =
        run_package_versions_command(dir, manager, package_name.trim().to_string())?;
    Ok(versions_report_from_command(command_result, package_name))
}

fn scan_package_workspace(root: &Path) -> Result<PackageWorkspaceSummary, String> {
    let root = canonical_root_path(root)?;
    let mut projects = Vec::new();

    let mut walker = WalkBuilder::new(&root);
    walker
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| {
                    !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
                        || !is_skipped_dir(name)
                })
                .unwrap_or(true)
        });

    for entry in walker.build().filter_map(Result::ok) {
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        if entry.file_name() != "package.json" {
            continue;
        }
        if let Ok(project) = inspect_package_json(&root, entry.path()) {
            projects.push(project);
        }
    }

    projects.sort_by(|a, b| a.relative_dir.cmp(&b.relative_dir));

    let mut manager_counts = BTreeMap::new();
    let mut warning_count = 0;
    for project in &projects {
        *manager_counts
            .entry(project.detected_manager.manager.command().to_string())
            .or_insert(0) += 1;
        warning_count += project.warnings.len();
    }

    Ok(PackageWorkspaceSummary {
        root: root.to_string_lossy().to_string(),
        projects,
        manager_counts,
        warning_count,
    })
}

fn inspect_package_json(root: &Path, package_json: &Path) -> Result<JsTsPackageProject, String> {
    let raw = fs::read_to_string(package_json).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let dir = package_json.parent().unwrap_or(root);
    let relative_dir = relative_dir(root, dir);
    let path = rel_path(root, package_json);
    let name = json
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            dir.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("package")
                .to_string()
        });
    let declared_package_manager = json
        .get("packageManager")
        .and_then(Value::as_str)
        .map(str::to_string);
    let lockfiles = detect_lockfiles(root, dir);
    let detected_manager = recommend_manager(declared_package_manager.as_deref(), &lockfiles);
    let scripts = object_keys(json.get("scripts"));
    let dependencies = read_dependency_list(&json);
    let dependency_counts = DependencyBuckets {
        dependencies: object_len(json.get("dependencies")),
        dev_dependencies: object_len(json.get("devDependencies")),
        peer_dependencies: object_len(json.get("peerDependencies")),
        optional_dependencies: object_len(json.get("optionalDependencies")),
    };
    let has_workspaces = json.get("workspaces").is_some();
    let warnings = project_warnings(declared_package_manager.as_deref(), &lockfiles);

    Ok(JsTsPackageProject {
        name,
        path,
        dir: dir.to_string_lossy().to_string(),
        relative_dir,
        declared_package_manager,
        detected_manager,
        lockfiles,
        scripts,
        dependencies,
        dependency_counts,
        has_workspaces,
        warnings,
    })
}

fn detect_lockfiles(root: &Path, dir: &Path) -> Vec<PackageLockfile> {
    [
        ("package-lock.json", PackageManager::Npm),
        ("npm-shrinkwrap.json", PackageManager::Npm),
        ("pnpm-lock.yaml", PackageManager::Pnpm),
        ("yarn.lock", PackageManager::Yarn),
        ("bun.lockb", PackageManager::Bun),
        ("bun.lock", PackageManager::Bun),
    ]
    .into_iter()
    .filter_map(|(name, manager)| {
        let path = dir.join(name);
        path.exists().then(|| PackageLockfile {
            name: name.to_string(),
            path: rel_path(root, &path),
            manager,
        })
    })
    .collect()
}

fn recommend_manager(
    declared: Option<&str>,
    lockfiles: &[PackageLockfile],
) -> PackageManagerRecommendation {
    if let Some(manager) = declared.and_then(parse_declared_manager) {
        return PackageManagerRecommendation {
            manager,
            confidence: RecommendationConfidence::High,
            reason: "Definido explicitamente no campo packageManager do package.json.".to_string(),
        };
    }

    let unique = unique_lockfile_managers(lockfiles);
    if unique.len() == 1 {
        return PackageManagerRecommendation {
            manager: unique[0],
            confidence: RecommendationConfidence::High,
            reason: format!("Detectado pelo lockfile {}.", lockfiles[0].name),
        };
    }

    if unique.len() > 1 {
        let manager = choose_manager_from_locks(&unique);
        return PackageManagerRecommendation {
            manager,
            confidence: RecommendationConfidence::Medium,
            reason: "Há múltiplos lockfiles; escolha sugerida pela prioridade pnpm/yarn/bun/npm até o usuário confirmar.".to_string(),
        };
    }

    PackageManagerRecommendation {
        manager: PackageManager::Npm,
        confidence: RecommendationConfidence::Low,
        reason: "Nenhum lockfile ou packageManager encontrado; npm é o fallback universal para package.json.".to_string(),
    }
}

fn project_warnings(declared: Option<&str>, lockfiles: &[PackageLockfile]) -> Vec<String> {
    let mut warnings = Vec::new();
    let unique = unique_lockfile_managers(lockfiles);

    if unique.len() > 1 {
        warnings.push(
            "Múltiplos lockfiles encontrados. Isso pode instalar árvores diferentes entre máquinas."
                .to_string(),
        );
    }

    if lockfiles.is_empty() {
        warnings.push(
            "Sem lockfile. Instalações podem variar entre máquinas/CI se versões não estiverem travadas."
                .to_string(),
        );
    }

    if let Some(declared_raw) = declared {
        match parse_declared_manager(declared_raw) {
            Some(declared_manager)
                if !unique.is_empty() && !unique.contains(&declared_manager) =>
            {
                warnings.push(format!(
                    "packageManager declara {}, mas os lockfiles apontam para outro gerenciador.",
                    declared_manager.command()
                ));
            }
            None => warnings.push(format!(
                "packageManager não reconhecido: {declared_raw}. Suportados agora: npm, pnpm, yarn e bun."
            )),
            _ => {}
        }
    }

    warnings
}

fn parse_declared_manager(raw: &str) -> Option<PackageManager> {
    let name = raw
        .split('@')
        .next()
        .unwrap_or(raw)
        .trim()
        .to_ascii_lowercase();
    match name.as_str() {
        "npm" => Some(PackageManager::Npm),
        "pnpm" => Some(PackageManager::Pnpm),
        "yarn" => Some(PackageManager::Yarn),
        "bun" => Some(PackageManager::Bun),
        _ => None,
    }
}

fn unique_lockfile_managers(lockfiles: &[PackageLockfile]) -> Vec<PackageManager> {
    let mut managers = lockfiles.iter().map(|l| l.manager).collect::<Vec<_>>();
    managers.sort();
    managers.dedup();
    managers
}

fn choose_manager_from_locks(managers: &[PackageManager]) -> PackageManager {
    [
        PackageManager::Pnpm,
        PackageManager::Yarn,
        PackageManager::Bun,
        PackageManager::Npm,
    ]
    .into_iter()
    .find(|candidate| managers.contains(candidate))
    .unwrap_or(PackageManager::Npm)
}

fn object_keys(value: Option<&Value>) -> Vec<String> {
    let mut keys = value
        .and_then(Value::as_object)
        .map(|obj| obj.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    keys.sort();
    keys
}

fn object_len(value: Option<&Value>) -> usize {
    value
        .and_then(Value::as_object)
        .map(|o| o.len())
        .unwrap_or(0)
}

pub(crate) enum PackageCommandKind {
    Outdated,
    Audit,
}

pub(crate) fn package_command_args(
    manager: PackageManager,
    kind: PackageCommandKind,
) -> Vec<&'static str> {
    match (manager, kind) {
        (PackageManager::Npm, PackageCommandKind::Outdated) => vec!["outdated", "--json"],
        (PackageManager::Pnpm, PackageCommandKind::Outdated) => {
            vec!["outdated", "--format", "json"]
        }
        (PackageManager::Yarn, PackageCommandKind::Outdated) => vec!["outdated", "--json"],
        (PackageManager::Bun, PackageCommandKind::Outdated) => vec!["outdated"],
        (PackageManager::Npm, PackageCommandKind::Audit) => vec!["audit", "--json"],
        (PackageManager::Pnpm, PackageCommandKind::Audit) => vec!["audit", "--json"],
        (PackageManager::Yarn, PackageCommandKind::Audit) => vec!["npm", "audit", "--json"],
        (PackageManager::Bun, PackageCommandKind::Audit) => vec!["audit", "--json"],
    }
}

pub(crate) fn package_versions_args(manager: PackageManager, package_name: &str) -> Vec<String> {
    match manager {
        PackageManager::Npm | PackageManager::Pnpm => {
            vec!["view", package_name, "versions", "--json"]
        }
        PackageManager::Yarn | PackageManager::Bun => {
            vec!["info", package_name, "versions", "--json"]
        }
    }
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(crate) fn read_declared_dependency_versions_from_str(
    raw: &str,
) -> Result<BTreeMap<String, String>, String> {
    let json: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    Ok(read_dependency_list(&json)
        .into_iter()
        .map(|dep| (dep.name, dep.declared_version))
        .collect())
}

pub(crate) fn outdated_report_from_command(
    command_result: PackageCommandResult,
    declared: &BTreeMap<String, String>,
) -> PackageOutdatedReport {
    let outdated = parse_outdated_report(&command_result.stdout, command_result.manager, declared);
    PackageOutdatedReport {
        command: command_result,
        outdated,
    }
}

pub(crate) fn audit_report_from_command(
    command_result: PackageCommandResult,
) -> PackageAuditReport {
    let summary = parse_audit_summary(&command_result.stdout);
    let vulnerabilities = parse_audit_vulnerabilities(&command_result.stdout);
    PackageAuditReport {
        command: command_result,
        summary,
        vulnerabilities,
    }
}

pub(crate) fn versions_report_from_command(
    command_result: PackageCommandResult,
    package_name: String,
) -> PackageVersionsReport {
    let versions = parse_versions_report(&command_result.stdout, command_result.manager);
    PackageVersionsReport {
        command: command_result,
        package_name,
        versions,
    }
}

fn run_package_command(
    dir: &Path,
    manager: PackageManager,
    kind: PackageCommandKind,
) -> Result<PackageCommandResult, String> {
    let mut command = Command::new(manager.command());
    command.current_dir(dir);
    command.args(package_command_args(manager, kind));
    hide_console_window(&mut command);
    let printable = format!("{:?}", command);
    let output = command.output().map_err(|e| {
        format!(
            "Não foi possível executar {}. Verifique se ele está no PATH. Detalhe: {e}",
            manager.command()
        )
    })?;

    Ok(PackageCommandResult {
        project_path: dir.to_string_lossy().to_string(),
        manager,
        command: printable,
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn run_package_versions_command(
    dir: &Path,
    manager: PackageManager,
    package_name: String,
) -> Result<PackageCommandResult, String> {
    if package_name.is_empty() {
        return Err("Nome do pacote vazio.".to_string());
    }

    let mut command = Command::new(manager.command());
    command.current_dir(dir);
    command.args(package_versions_args(manager, &package_name));
    hide_console_window(&mut command);
    let printable = format!("{:?}", command);
    let output = command.output().map_err(|e| {
        format!(
            "Não foi possível executar {}. Verifique se ele está no PATH. Detalhe: {e}",
            manager.command()
        )
    })?;

    Ok(PackageCommandResult {
        project_path: dir.to_string_lossy().to_string(),
        manager,
        command: printable,
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn read_dependency_list(json: &Value) -> Vec<PackageDependency> {
    let mut deps = Vec::new();
    push_dependencies(
        json,
        "dependencies",
        DependencyKind::Dependencies,
        &mut deps,
    );
    push_dependencies(
        json,
        "devDependencies",
        DependencyKind::DevDependencies,
        &mut deps,
    );
    push_dependencies(
        json,
        "peerDependencies",
        DependencyKind::PeerDependencies,
        &mut deps,
    );
    push_dependencies(
        json,
        "optionalDependencies",
        DependencyKind::OptionalDependencies,
        &mut deps,
    );
    deps.sort_by(|a, b| a.name.cmp(&b.name));
    deps
}

fn push_dependencies(
    json: &Value,
    key: &str,
    kind: DependencyKind,
    deps: &mut Vec<PackageDependency>,
) {
    let Some(obj) = json.get(key).and_then(Value::as_object) else {
        return;
    };
    for (name, version) in obj {
        let Some(version) = version.as_str() else {
            continue;
        };
        deps.push(PackageDependency {
            name: name.clone(),
            declared_version: version.to_string(),
            kind: kind.clone(),
        });
    }
}

fn read_declared_dependency_versions(
    package_json: &Path,
) -> Result<BTreeMap<String, String>, String> {
    let raw = fs::read_to_string(package_json).map_err(|e| e.to_string())?;
    read_declared_dependency_versions_from_str(&raw)
}

fn parse_outdated_report(
    stdout: &str,
    manager: PackageManager,
    declared: &BTreeMap<String, String>,
) -> Vec<PackageOutdatedDependency> {
    let mut out = match manager {
        PackageManager::Npm => parse_npm_outdated(stdout, declared),
        PackageManager::Pnpm => parse_pnpm_outdated(stdout, declared),
        // Yarn classic prints newline-delimited JSON events; keep raw output
        // available until we support that format. Bun prints a stable table.
        PackageManager::Yarn => Vec::new(),
        PackageManager::Bun => parse_bun_outdated(stdout, declared),
    };
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn parse_npm_outdated(
    stdout: &str,
    declared: &BTreeMap<String, String>,
) -> Vec<PackageOutdatedDependency> {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    let Some(obj) = value.as_object() else {
        return Vec::new();
    };
    obj.iter()
        .filter_map(|(name, info)| {
            Some(PackageOutdatedDependency {
                name: name.clone(),
                current: string_field(info, "current"),
                wanted: string_field(info, "wanted"),
                latest: string_field(info, "latest"),
                declared_version: declared.get(name).cloned(),
            })
        })
        .collect()
}

fn parse_pnpm_outdated(
    stdout: &str,
    declared: &BTreeMap<String, String>,
) -> Vec<PackageOutdatedDependency> {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    if let Some(arr) = value.as_array() {
        return arr
            .iter()
            .filter_map(|info| {
                let name = string_field(info, "package").or_else(|| string_field(info, "name"))?;
                Some(PackageOutdatedDependency {
                    declared_version: declared.get(&name).cloned(),
                    name,
                    current: string_field(info, "current"),
                    wanted: string_field(info, "wanted"),
                    latest: string_field(info, "latest"),
                })
            })
            .collect();
    }
    parse_npm_outdated(stdout, declared)
}

fn parse_bun_outdated(
    stdout: &str,
    declared: &BTreeMap<String, String>,
) -> Vec<PackageOutdatedDependency> {
    stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if !trimmed.starts_with('|') || trimmed.contains("---") || trimmed.contains("Package") {
                return None;
            }
            let cols = trimmed
                .trim_matches('|')
                .split('|')
                .map(str::trim)
                .collect::<Vec<_>>();
            if cols.len() < 4 {
                return None;
            }
            let name = cols[0]
                .strip_suffix(" (dev)")
                .or_else(|| cols[0].strip_suffix(" (optional)"))
                .or_else(|| cols[0].strip_suffix(" (peer)"))
                .unwrap_or(cols[0])
                .to_string();
            if name.is_empty() {
                return None;
            }
            Some(PackageOutdatedDependency {
                declared_version: declared.get(&name).cloned(),
                name,
                current: non_empty_col(cols[1]),
                wanted: non_empty_col(cols[2]),
                latest: non_empty_col(cols[3]),
            })
        })
        .collect()
}

fn non_empty_col(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "-" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_audit_summary(stdout: &str) -> AuditSummary {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return AuditSummary::default();
    };
    if let Some(vulnerabilities) = value.get("metadata").and_then(|m| m.get("vulnerabilities")) {
        return AuditSummary {
            total: usize_field(vulnerabilities, "total"),
            low: usize_field(vulnerabilities, "low"),
            moderate: usize_field(vulnerabilities, "moderate"),
            high: usize_field(vulnerabilities, "high"),
            critical: usize_field(vulnerabilities, "critical"),
        };
    }
    if let Some(summary) = value.get("summary") {
        return AuditSummary {
            total: usize_field(summary, "total"),
            low: usize_field(summary, "low"),
            moderate: usize_field(summary, "moderate"),
            high: usize_field(summary, "high"),
            critical: usize_field(summary, "critical"),
        };
    }
    AuditSummary::default()
}

fn parse_audit_vulnerabilities(stdout: &str) -> Vec<PackageAuditVulnerability> {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    let mut result = Vec::new();

    if let Some(vulnerabilities) = value.get("vulnerabilities").and_then(Value::as_object) {
        for (package, item) in vulnerabilities {
            let severity = string_field(item, "severity").unwrap_or_else(|| "unknown".to_string());
            let range = string_field(item, "range");
            let fix_available = item
                .get("fixAvailable")
                .map(|v| {
                    v.as_bool()
                        .unwrap_or(!v.is_null() && v != &Value::Bool(false))
                })
                .unwrap_or(false);

            if let Some(via) = item.get("via").and_then(Value::as_array) {
                let advisories: Vec<&Value> =
                    via.iter().filter(|entry| entry.is_object()).collect();
                if advisories.is_empty() {
                    result.push(PackageAuditVulnerability {
                        package: package.clone(),
                        severity,
                        title: package.clone(),
                        url: None,
                        range,
                        fix_available,
                    });
                } else {
                    for advisory in advisories {
                        result.push(PackageAuditVulnerability {
                            package: package.clone(),
                            severity: string_field(advisory, "severity")
                                .unwrap_or_else(|| severity.clone()),
                            title: string_field(advisory, "title")
                                .unwrap_or_else(|| package.clone()),
                            url: string_field(advisory, "url"),
                            range: string_field(advisory, "range").or_else(|| range.clone()),
                            fix_available,
                        });
                    }
                }
            }
        }
    }

    if let Some(advisories) = value.get("advisories").and_then(Value::as_object) {
        for advisory in advisories.values() {
            let package = string_field(advisory, "module_name")
                .or_else(|| string_field(advisory, "moduleName"))
                .unwrap_or_else(|| "unknown".to_string());
            result.push(PackageAuditVulnerability {
                package,
                severity: string_field(advisory, "severity")
                    .unwrap_or_else(|| "unknown".to_string()),
                title: string_field(advisory, "title")
                    .unwrap_or_else(|| "Vulnerabilidade".to_string()),
                url: string_field(advisory, "url"),
                range: string_field(advisory, "vulnerable_versions")
                    .or_else(|| string_field(advisory, "vulnerableVersions")),
                fix_available: advisory
                    .get("fix_available")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
    }

    result.sort_by(|a, b| {
        severity_rank(&a.severity)
            .cmp(&severity_rank(&b.severity))
            .then_with(|| a.package.cmp(&b.package))
            .then_with(|| a.title.cmp(&b.title))
    });
    result.dedup_by(|a, b| {
        a.package == b.package
            && a.title == b.title
            && a.severity == b.severity
            && a.range == b.range
    });
    result
}

fn severity_rank(severity: &str) -> u8 {
    match severity.to_ascii_lowercase().as_str() {
        "critical" => 0,
        "high" => 1,
        "moderate" | "medium" => 2,
        "low" => 3,
        _ => 4,
    }
}

fn parse_versions_report(stdout: &str, manager: PackageManager) -> Vec<String> {
    let mut versions = parse_versions_json(stdout).unwrap_or_default();
    if versions.is_empty() && manager == PackageManager::Yarn {
        versions = stdout
            .lines()
            .find_map(parse_versions_json)
            .unwrap_or_default();
    }
    versions.sort_by(|a, b| version_sort_key(a).cmp(&version_sort_key(b)));
    versions.dedup();
    versions
}

fn parse_versions_json(raw: &str) -> Option<Vec<String>> {
    let value: Value = serde_json::from_str(raw.trim()).ok()?;
    versions_from_value(&value)
}

fn versions_from_value(value: &Value) -> Option<Vec<String>> {
    if let Some(arr) = value.as_array() {
        return Some(
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        );
    }
    if let Some(data) = value.get("data") {
        return versions_from_value(data);
    }
    if let Some(versions) = value.get("versions") {
        return versions_from_value(versions);
    }
    None
}

fn version_sort_key(version: &str) -> Vec<u64> {
    version
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .take(4)
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn usize_field(value: &Value, key: &str) -> usize {
    value.get(key).and_then(Value::as_u64).unwrap_or(0) as usize
}

fn canonical_root(root: &str) -> Result<std::path::PathBuf, String> {
    canonical_root_path(Path::new(root))
}

fn canonical_root_path(root: &Path) -> Result<std::path::PathBuf, String> {
    root.canonicalize()
        .map_err(|e| format!("Não foi possível abrir o workspace: {e}"))
}

fn resolve_project_manifest(root: &Path, project_path: &str) -> Result<std::path::PathBuf, String> {
    let candidate = root.join(project_path);
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("package.json não encontrado: {e}"))?;
    if !canonical.starts_with(root) {
        return Err("Projeto fora do workspace.".to_string());
    }
    if canonical.file_name().and_then(|n| n.to_str()) != Some("package.json") {
        return Err("O caminho precisa apontar para um package.json.".to_string());
    }
    Ok(canonical)
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn relative_dir(root: &Path, dir: &Path) -> String {
    let rel = rel_path(root, dir);
    if rel.is_empty() {
        ".".to_string()
    } else {
        rel
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock(name: &str, manager: PackageManager) -> PackageLockfile {
        PackageLockfile {
            name: name.to_string(),
            path: name.to_string(),
            manager,
        }
    }

    #[test]
    fn declared_package_manager_wins_over_lockfile() {
        let rec = recommend_manager(
            Some("pnpm@9.0.0"),
            &[lock("package-lock.json", PackageManager::Npm)],
        );

        assert_eq!(rec.manager, PackageManager::Pnpm);
        assert!(matches!(rec.confidence, RecommendationConfidence::High));
    }

    #[test]
    fn single_lockfile_is_high_confidence() {
        let rec = recommend_manager(None, &[lock("yarn.lock", PackageManager::Yarn)]);

        assert_eq!(rec.manager, PackageManager::Yarn);
        assert!(matches!(rec.confidence, RecommendationConfidence::High));
    }

    #[test]
    fn multiple_lockfiles_are_medium_confidence_and_warn() {
        let locks = vec![
            lock("package-lock.json", PackageManager::Npm),
            lock("pnpm-lock.yaml", PackageManager::Pnpm),
        ];
        let rec = recommend_manager(None, &locks);
        let warnings = project_warnings(None, &locks);

        assert_eq!(rec.manager, PackageManager::Pnpm);
        assert!(matches!(rec.confidence, RecommendationConfidence::Medium));
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn parses_bun_outdated_table() {
        let stdout = r#"
| Package                        | Current | Update    | Latest     |
| ------------------------------ | ------- | --------- | ---------- |
| @sinclair/typebox              | 0.34.15 | 0.34.16   | 0.34.16    |
| @types/bun (dev)               | 1.3.0   | 1.3.3     | 1.3.3      |
"#;
        let mut declared = BTreeMap::new();
        declared.insert("@sinclair/typebox".to_string(), "^0.34.15".to_string());
        declared.insert("@types/bun".to_string(), "^1.3.0".to_string());

        let outdated = parse_bun_outdated(stdout, &declared);

        assert_eq!(outdated.len(), 2);
        assert_eq!(outdated[0].name, "@sinclair/typebox");
        assert_eq!(outdated[0].latest.as_deref(), Some("0.34.16"));
        assert_eq!(outdated[1].name, "@types/bun");
        assert_eq!(outdated[1].declared_version.as_deref(), Some("^1.3.0"));
    }

    #[test]
    fn parses_versions_from_plain_json_array() {
        let versions = parse_versions_report(
            r#"["0.10.0","0.11.0","1.0.0","2.0.0"]"#,
            PackageManager::Npm,
        );

        assert_eq!(versions, vec!["0.10.0", "0.11.0", "1.0.0", "2.0.0"]);
    }

    #[test]
    fn parses_versions_from_object_or_yarn_event() {
        let bun = parse_versions_report(
            r#"{"versions":["1.0.0","1.2.0","2.0.0"]}"#,
            PackageManager::Bun,
        );
        let yarn = parse_versions_report(
            r#"{"type":"inspect","data":["0.1.0","0.2.0","1.0.0"]}"#,
            PackageManager::Yarn,
        );

        assert_eq!(bun, vec!["1.0.0", "1.2.0", "2.0.0"]);
        assert_eq!(yarn, vec!["0.1.0", "0.2.0", "1.0.0"]);
    }

    #[test]
    fn parses_npm_audit_vulnerabilities_by_package() {
        let stdout = r#"{
          "auditReportVersion": 2,
          "vulnerabilities": {
            "lodash": {
              "name": "lodash",
              "severity": "high",
              "range": "<4.17.21",
              "fixAvailable": true,
              "via": [
                {
                  "source": 123,
                  "name": "lodash",
                  "dependency": "lodash",
                  "title": "Prototype Pollution",
                  "url": "https://example.test/advisory",
                  "severity": "high",
                  "range": "<4.17.21"
                }
              ]
            }
          },
          "metadata": {
            "vulnerabilities": {
              "info": 0,
              "low": 0,
              "moderate": 0,
              "high": 1,
              "critical": 0,
              "total": 1
            }
          }
        }"#;

        let summary = parse_audit_summary(stdout);
        let vulnerabilities = parse_audit_vulnerabilities(stdout);

        assert_eq!(summary.total, 1);
        assert_eq!(summary.high, 1);
        assert_eq!(vulnerabilities.len(), 1);
        assert_eq!(vulnerabilities[0].package, "lodash");
        assert_eq!(vulnerabilities[0].severity, "high");
        assert_eq!(vulnerabilities[0].title, "Prototype Pollution");
        assert_eq!(vulnerabilities[0].range.as_deref(), Some("<4.17.21"));
        assert!(vulnerabilities[0].fix_available);
    }
}
