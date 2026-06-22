//! A minimal, read-only **MCP server** (Model Context Protocol, stdio transport)
//! that exposes the workspace knowledge index as tools — so Claude Code (and any
//! MCP client) can query the project's "brain": related files, backlinks,
//! outline, and a knowledge search.
//!
//! It runs as a subcommand of the same binary: `fluent-coder --mcp <root>`. The
//! GUI entry point ([lib.rs]) detects the flag and calls [`run_mcp_server`]
//! instead of starting Tauri. Transport is newline-delimited JSON-RPC 2.0 (the
//! MCP stdio convention): one message per line, logs go to stderr.

use crate::graph::{build_knowledge_index, context_bundle_from, find_file, KnowledgeIndex};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;

const PROTOCOL_VERSION: &str = "2024-11-05";

/// The data the UI needs to wire this MCP server into an MCP client (Claude Code).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    /// Absolute path of the running editor executable.
    pub exe: String,
    /// One-liner for `claude mcp add`.
    pub claude_add: String,
    /// A ready-to-paste `.mcp.json` snippet.
    pub json_config: String,
}

/// Returns how to register this MCP server for `root` in an MCP client.
#[tauri::command]
pub fn mcp_config(root: String) -> Result<McpConfig, String> {
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    let claude_add = format!("claude mcp add fluent-knowledge -- \"{exe}\" --mcp \"{root}\"");
    let json_config = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "fluent-knowledge": { "command": exe, "args": ["--mcp", root] }
        }
    }))
    .unwrap_or_default();
    Ok(McpConfig {
        exe,
        claude_add,
        json_config,
    })
}

/// Writes (merging into any existing) a project-scoped `.mcp.json` at `root`, so
/// an MCP client like Claude Code auto-detects the knowledge server when it opens
/// the project — no manual `claude mcp add` needed. Returns the file path.
#[tauri::command]
pub fn mcp_write_project_config(root: String) -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    let path = Path::new(&root).join(".mcp.json");
    let mut doc: Value = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    if !doc.is_object() {
        doc = json!({});
    }
    let servers = doc
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if let Some(obj) = servers.as_object_mut() {
        obj.insert(
            "fluent-knowledge".into(),
            json!({ "command": exe, "args": ["--mcp", root] }),
        );
    }
    let out = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Runs the stdio MCP loop until stdin closes. Never returns to the GUI.
pub fn run_mcp_server(root: String) {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    // Built lazily on the first tool call, rebuilt by `refresh_index`.
    let mut index: Option<KnowledgeIndex> = None;
    eprintln!("[mcp] knowledge server up for {root}");

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[mcp] json inválido: {e}");
                continue;
            }
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        // Notifications (no id) get no response.
        if id.is_none() {
            continue;
        }
        let reply = match handle(method, &msg, &root, &mut index) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(message) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": message } })
            }
        };
        if writeln!(out, "{reply}").is_err() {
            break;
        }
        let _ = out.flush();
    }
}

fn handle(
    method: &str,
    msg: &Value,
    root: &str,
    index: &mut Option<KnowledgeIndex>,
) -> Result<Value, String> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fluent-coder-knowledge", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_specs() })),
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            if index.is_none() {
                *index = Some(build_knowledge_index(root.to_string())?);
            }
            if name == "refresh_index" {
                *index = Some(build_knowledge_index(root.to_string())?);
                return Ok(text_result("Índice reanalisado."));
            }
            let idx = index.as_ref().unwrap();
            let text = call_tool(name, &args, idx, root)?;
            Ok(text_result(&text))
        }
        _ => Err(format!("método não suportado: {method}")),
    }
}

/// Wraps a string as an MCP tool-call text result.
fn text_result(text: &str) -> Value {
    json!({ "content": [ { "type": "text", "text": text } ] })
}

/// The tool catalogue (name + description + JSON-Schema for arguments).
fn tool_specs() -> Value {
    let path_arg = json!({
        "type": "object",
        "properties": { "path": { "type": "string", "description": "Caminho do arquivo (absoluto ou relativo à raiz do projeto)." } },
        "required": ["path"],
    });
    json!([
        {
            "name": "search_knowledge",
            "description": "Busca arquivos do projeto por nome, caminho, tags (#tag) ou títulos (headings). Retorna os arquivos mais relevantes.",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string", "description": "Termo de busca." } },
                "required": ["query"],
            },
        },
        {
            "name": "get_backlinks",
            "description": "Lista os arquivos que apontam para o arquivo dado (backlinks/menções vinculadas), com a linha e o trecho de contexto.",
            "inputSchema": path_arg,
        },
        {
            "name": "get_related_files",
            "description": "Lista os arquivos diretamente conectados ao arquivo dado (links/imports de saída + backlinks de entrada) — a vizinhança no grafo de contexto.",
            "inputSchema": path_arg,
        },
        {
            "name": "get_outline",
            "description": "Retorna o outline (títulos/headings) de um arquivo markdown.",
            "inputSchema": path_arg,
        },
        {
            "name": "get_context_bundle",
            "description": "Monta um 'pacote de contexto' em markdown: o conteúdo do arquivo dado MAIS o dos arquivos vizinhos no grafo (links/imports), até `depth` saltos — pronto para alimentar o raciocínio sobre uma tarefa.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Arquivo semente (absoluto ou relativo)." },
                    "depth": { "type": "integer", "description": "Saltos no grafo (1–3, padrão 1).", "minimum": 1, "maximum": 3 }
                },
                "required": ["path"],
            },
        },
        {
            "name": "refresh_index",
            "description": "Reanalisa o workspace (use após mudanças nos arquivos).",
            "inputSchema": { "type": "object", "properties": {} },
        },
    ])
}

fn call_tool(
    name: &str,
    args: &Value,
    idx: &KnowledgeIndex,
    _root: &str,
) -> Result<String, String> {
    let arg_str = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match name {
        "search_knowledge" => {
            let q = arg_str("query").to_lowercase();
            if q.is_empty() {
                return Err("argumento 'query' obrigatório".into());
            }
            let mut hits: Vec<String> = Vec::new();
            for f in &idx.files {
                let in_name = f.rel.to_lowercase().contains(&q);
                let in_tags = f.tags.iter().any(|t| t.to_lowercase().contains(&q));
                let heads: Vec<&str> = f
                    .headings
                    .iter()
                    .filter(|h| h.text.to_lowercase().contains(&q))
                    .map(|h| h.text.as_str())
                    .collect();
                if in_name || in_tags || !heads.is_empty() {
                    let mut line = format!("- {} ({})", f.rel, f.kind);
                    if !heads.is_empty() {
                        line.push_str(&format!("  · headings: {}", heads.join(" / ")));
                    }
                    if in_tags {
                        line.push_str(&format!("  · tags: {}", f.tags.join(", ")));
                    }
                    hits.push(line);
                }
                if hits.len() >= 50 {
                    break;
                }
            }
            if hits.is_empty() {
                Ok(format!("Nenhum resultado para \"{q}\"."))
            } else {
                Ok(format!("{} resultado(s):\n{}", hits.len(), hits.join("\n")))
            }
        }
        "get_backlinks" => {
            let f = find_file(idx, &arg_str("path")).ok_or("arquivo não encontrado no índice")?;
            let mut out: Vec<String> = Vec::new();
            for src in &idx.files {
                if src.path == f.path {
                    continue;
                }
                for l in &src.outgoing {
                    if l.target == f.path {
                        out.push(format!(
                            "- {}:{} [{}]  {}",
                            src.rel, l.line, l.relation, l.snippet
                        ));
                    }
                }
            }
            if out.is_empty() {
                Ok(format!("Nenhum backlink para {}.", f.rel))
            } else {
                Ok(format!(
                    "{} backlink(s) para {}:\n{}",
                    out.len(),
                    f.rel,
                    out.join("\n")
                ))
            }
        }
        "get_related_files" => {
            let f = find_file(idx, &arg_str("path")).ok_or("arquivo não encontrado no índice")?;
            let rel_of = |p: &str| {
                idx.files
                    .iter()
                    .find(|x| x.path == p)
                    .map(|x| x.rel.clone())
                    .unwrap_or_else(|| p.to_string())
            };
            let mut outgoing: Vec<String> = f
                .outgoing
                .iter()
                .map(|l| format!("→ {} [{}]", rel_of(&l.target), l.relation))
                .collect();
            outgoing.sort();
            outgoing.dedup();
            let mut incoming: Vec<String> = Vec::new();
            for src in &idx.files {
                if src.path != f.path && src.outgoing.iter().any(|l| l.target == f.path) {
                    incoming.push(format!("← {}", src.rel));
                }
            }
            incoming.sort();
            incoming.dedup();
            if outgoing.is_empty() && incoming.is_empty() {
                return Ok(format!("{} não tem conexões.", f.rel));
            }
            Ok(format!(
                "Conexões de {}:\n{}\n{}",
                f.rel,
                outgoing.join("\n"),
                incoming.join("\n")
            ))
        }
        "get_outline" => {
            let f = find_file(idx, &arg_str("path")).ok_or("arquivo não encontrado no índice")?;
            if f.headings.is_empty() {
                return Ok(format!("{} não tem títulos.", f.rel));
            }
            let lines: Vec<String> = f
                .headings
                .iter()
                .map(|h| {
                    format!(
                        "{}{} (L{})",
                        "  ".repeat(h.level.saturating_sub(1)),
                        h.text,
                        h.line
                    )
                })
                .collect();
            Ok(format!("Outline de {}:\n{}", f.rel, lines.join("\n")))
        }
        "get_context_bundle" => {
            let depth = args.get("depth").and_then(|d| d.as_u64()).unwrap_or(1) as usize;
            context_bundle_from(idx, &arg_str("path"), depth, 60_000, &|p| {
                std::fs::read_to_string(p).unwrap_or_default()
            })
        }
        other => Err(format!("ferramenta desconhecida: {other}")),
    }
}
