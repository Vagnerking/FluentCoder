/// Indexador de símbolos C# do workspace sem Roslyn (issue #41).
///
/// Extrai declarações de nível de arquivo (namespaces, tipos, membros) por
/// scanning de tokens simples — sem compilar, sem Roslyn, sem tree-sitter.
///
/// Resultados são `resolved`, `ambiguous` ou `unknown` — sem inferências silenciosas.
/// Atualização incremental: re-indexa apenas o arquivo alterado.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use crate::cshtml::types::{TextPosition, TextRange};

// ── Tipos de símbolo ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SymbolKind {
    Namespace,
    Class,
    Struct,
    Record,
    Interface,
    Enum,
    EnumMember,
    Method,
    Constructor,
    Property,
    Field,
    Event,
}

/// Representação de um tipo (potencialmente genérico, nullable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeRef {
    pub name: String,
    pub type_args: Vec<TypeRef>,
    pub nullable: bool,
    pub array_dims: u32,
}

impl TypeRef {
    pub fn simple(name: impl Into<String>) -> Self {
        TypeRef { name: name.into(), type_args: vec![], nullable: false, array_dims: 0 }
    }
}

/// Um símbolo declarado em código C#.
#[derive(Debug, Clone)]
pub struct CSharpSymbol {
    /// ID estável: `"<file_key>::<fully_qualified_name>"`.
    pub id: String,
    pub kind: SymbolKind,
    pub name: String,
    pub namespace: String,
    pub return_type: Option<TypeRef>,
    pub parameters: Vec<(String, TypeRef)>,
    pub base_types: Vec<String>,
    pub modifiers: Vec<String>,
    pub range: TextRange,
    pub file: PathBuf,
    pub children: Vec<String>,
}

/// Resolução de um nome qualificado.
#[derive(Debug, Clone)]
pub enum Resolution {
    Resolved(CSharpSymbol),
    Ambiguous(Vec<CSharpSymbol>),
    Unknown,
}

// ── Scanner ───────────────────────────────────────────────────────────────────

struct Scanner {
    chars: Vec<char>,
    pos: usize,
    line: u32,
    col: u32,
}

impl Scanner {
    fn new(src: &str) -> Self {
        Scanner { chars: src.chars().collect(), pos: 0, line: 0, col: 0 }
    }

    fn at_end(&self) -> bool { self.pos >= self.chars.len() }
    fn peek(&self) -> Option<char> { self.chars.get(self.pos).copied() }
    fn peek2(&self) -> Option<char> { self.chars.get(self.pos + 1).copied() }

    fn advance(&mut self) -> Option<char> {
        let ch = self.chars.get(self.pos).copied()?;
        self.pos += 1;
        if ch == '\n' { self.line += 1; self.col = 0; }
        else { self.col += ch.len_utf16() as u32; }
        Some(ch)
    }

    fn current_pos(&self) -> TextPosition {
        TextPosition { line: self.line, character: self.col }
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) { self.advance(); }
    }

    fn skip_line_comment(&mut self) {
        while let Some(c) = self.advance() { if c == '\n' { break; } }
    }

    fn skip_block_comment(&mut self) {
        loop {
            if self.at_end() { break; }
            if self.peek() == Some('*') && self.peek2() == Some('/') {
                self.advance(); self.advance(); break;
            }
            self.advance();
        }
    }

    fn skip_string(&mut self, verbatim: bool) {
        if verbatim {
            loop {
                match self.advance() {
                    None => break,
                    Some('"') => { if self.peek() == Some('"') { self.advance(); } else { break; } }
                    _ => {}
                }
            }
        } else {
            loop {
                match self.advance() {
                    None | Some('\n') => break,
                    Some('\\') => { self.advance(); }
                    Some('"') => break,
                    _ => {}
                }
            }
        }
    }

    fn skip_char_lit(&mut self) {
        loop {
            match self.advance() {
                None | Some('\n') => break,
                Some('\\') => { self.advance(); }
                Some('\'') => break,
                _ => {}
            }
        }
    }

    fn read_ident(&mut self) -> String {
        if self.peek() == Some('@') { self.advance(); }
        let mut s = String::new();
        while matches!(self.peek(), Some(c) if c.is_alphanumeric() || c == '_') {
            s.push(self.advance().unwrap());
        }
        s
    }

    // Advance past comments and whitespace, peek at next real char.
    fn skip_trivia(&mut self) {
        loop {
            self.skip_ws();
            match (self.peek(), self.peek2()) {
                (Some('/'), Some('/')) => { self.advance(); self.advance(); self.skip_line_comment(); }
                (Some('/'), Some('*')) => { self.advance(); self.advance(); self.skip_block_comment(); }
                _ => break,
            }
        }
    }

    fn read_type_str(&mut self) -> String {
        self.skip_trivia();
        let mut t = String::new();
        if self.peek() == Some('@') { self.advance(); }
        while matches!(self.peek(), Some(c) if c.is_alphanumeric() || c == '_' || c == '.') {
            t.push(self.advance().unwrap());
        }
        self.skip_ws();
        if self.peek() == Some('<') {
            t.push('<');
            self.advance();
            let mut depth = 1i32;
            while !self.at_end() && depth > 0 {
                match self.advance() {
                    Some('<') => { depth += 1; t.push('<'); }
                    Some('>') => { depth -= 1; if depth >= 0 { t.push('>'); } }
                    Some(c) => t.push(c),
                    None => break,
                }
            }
        }
        if self.peek() == Some('?') { t.push('?'); self.advance(); }
        loop {
            self.skip_ws();
            if self.peek() == Some('[') {
                t.push('[');
                self.advance();
                while let Some(c) = self.advance() { t.push(c); if c == ']' { break; } }
            } else { break; }
        }
        t
    }

    fn skip_balanced(&mut self, open: char, close: char) {
        let mut depth = 1i32;
        while !self.at_end() && depth > 0 {
            match self.peek().unwrap() {
                c if c == open => { depth += 1; self.advance(); }
                c if c == close => { depth -= 1; self.advance(); }
                '"' => { self.advance(); self.skip_string(false); }
                '\'' => { self.advance(); self.skip_char_lit(); }
                '/' if self.peek2() == Some('/') => { self.advance(); self.advance(); self.skip_line_comment(); }
                '/' if self.peek2() == Some('*') => { self.advance(); self.advance(); self.skip_block_comment(); }
                _ => { self.advance(); }
            }
        }
    }

    fn skip_to_semi_or_block(&mut self) {
        while let Some(c) = self.peek() {
            match c {
                ';' => { self.advance(); return; }
                '{' => { self.advance(); self.skip_balanced('{', '}'); return; }
                '"' => { self.advance(); self.skip_string(false); }
                '\'' => { self.advance(); self.skip_char_lit(); }
                _ => { self.advance(); }
            }
        }
    }

    fn read_params(&mut self) -> Vec<(String, TypeRef)> {
        let mut params = Vec::new();
        loop {
            self.skip_trivia();
            if self.at_end() || self.peek() == Some(')') { self.advance(); break; }
            // Skip modifiers
            for m in &["ref ", "out ", "in ", "params ", "this "] {
                let remaining: String = self.chars[self.pos..].iter().collect();
                if remaining.starts_with(m) {
                    for _ in 0..m.len() { self.advance(); }
                    break;
                }
            }
            let ty = self.read_type_str();
            self.skip_trivia();
            let name = self.read_ident();
            if !ty.is_empty() || !name.is_empty() {
                params.push((name, TypeRef::simple(ty)));
            }
            self.skip_trivia();
            match self.peek() {
                Some(',') => { self.advance(); }
                Some(')') => { self.advance(); break; }
                _ => break,
            }
        }
        params
    }

    fn read_base_types(&mut self) -> Vec<String> {
        let mut result = Vec::new();
        loop {
            self.skip_trivia();
            match self.peek() {
                None | Some('{') | Some(';') => break,
                _ => {}
            }
            let t = self.read_type_str();
            if !t.is_empty() { result.push(t); }
            self.skip_trivia();
            if self.peek() == Some(',') { self.advance(); } else { break; }
        }
        result
    }
}

// ── Parser de declarações ─────────────────────────────────────────────────────

struct Parser {
    sc: Scanner,
    file: PathBuf,
    namespace: String,
    type_stack: Vec<String>,
    out: Vec<CSharpSymbol>,
}

impl Parser {
    fn new(src: &str, file: PathBuf) -> Self {
        Parser { sc: Scanner::new(src), file, namespace: String::new(), type_stack: Vec::new(), out: Vec::new() }
    }

    fn fq_name(&self, name: &str) -> String {
        let parts: Vec<&str> = self.type_stack.iter().map(|s| s.as_str())
            .chain(std::iter::once(name)).collect();
        if self.namespace.is_empty() { parts.join(".") }
        else { format!("{}.{}", self.namespace, parts.join(".")) }
    }

    fn make_id(&self, name: &str) -> String {
        format!("{}::{}", self.file.to_string_lossy(), self.fq_name(name))
    }

    fn parse_all(&mut self) {
        loop {
            self.sc.skip_trivia();
            if self.sc.at_end() { break; }
            self.parse_decl();
        }
    }

    fn parse_decl(&mut self) {
        self.sc.skip_trivia();
        if self.sc.at_end() { return; }

        let start = self.sc.current_pos();

        // Collect modifiers/keyword
        let mut mods: Vec<String> = Vec::new();
        loop {
            self.sc.skip_trivia();
            if self.sc.at_end() { return; }

            // Attribute
            if self.sc.peek() == Some('[') {
                self.sc.advance();
                self.sc.skip_balanced('[', ']');
                continue;
            }

            // Non-identifier
            if !matches!(self.sc.peek(), Some(c) if c.is_alphabetic() || c == '_' || c == '@') {
                self.sc.skip_to_semi_or_block();
                return;
            }

            let word = self.sc.read_ident();
            self.sc.skip_trivia();

            match word.as_str() {
                "public" | "private" | "protected" | "internal" | "static"
                | "abstract" | "virtual" | "override" | "sealed" | "partial"
                | "readonly" | "async" | "extern" | "new" | "unsafe" | "required" => {
                    mods.push(word);
                }
                "namespace" => { self.parse_namespace(); return; }
                "using" => { self.sc.skip_to_semi_or_block(); return; }
                "class" => { self.parse_type("class", mods, start); return; }
                "struct" => { self.parse_type("struct", mods, start); return; }
                "record" => { self.parse_type("record", mods, start); return; }
                "interface" => { self.parse_type("interface", mods, start); return; }
                "enum" => { self.parse_enum(mods, start); return; }
                "event" => { self.parse_event(mods, start); return; }
                other => {
                    // Treat as return-type of a member.
                    let rt = other.to_string();
                    self.parse_member_after_type(&rt, mods, start);
                    return;
                }
            }
        }
    }

    fn parse_namespace(&mut self) {
        self.sc.skip_trivia();
        let mut ns = String::new();
        loop {
            let part = self.sc.read_ident();
            if !part.is_empty() { ns.push_str(&part); }
            self.sc.skip_trivia();
            if self.sc.peek() == Some('.') { self.sc.advance(); ns.push('.'); } else { break; }
        }
        self.sc.skip_trivia();

        let parent_ns = self.namespace.clone();
        self.namespace = if parent_ns.is_empty() { ns.clone() }
                         else { format!("{parent_ns}.{ns}") };

        match self.sc.peek() {
            Some('{') => {
                self.sc.advance();
                let mut depth = 1i32;
                loop {
                    self.sc.skip_trivia();
                    if self.sc.at_end() { break; }
                    match self.sc.peek() {
                        Some('}') => { depth -= 1; self.sc.advance(); if depth <= 0 { break; } }
                        _ => self.parse_decl(),
                    }
                }
            }
            Some(';') => {
                self.sc.advance();
                // File-scoped namespace — rest of file.
                loop {
                    self.sc.skip_trivia();
                    if self.sc.at_end() { break; }
                    self.parse_decl();
                }
            }
            _ => {}
        }
        self.namespace = parent_ns;
    }

    fn parse_type(&mut self, keyword: &str, mods: Vec<String>, start: TextPosition) {
        self.sc.skip_trivia();
        let name = self.sc.read_ident();
        if name.is_empty() { self.sc.skip_to_semi_or_block(); return; }

        // Generic params `<T, K>` — skip entirely
        self.sc.skip_trivia();
        if self.sc.peek() == Some('<') {
            self.sc.advance();
            self.sc.skip_balanced('<', '>');
        }
        self.sc.skip_trivia();

        // Base types
        let mut base_types = Vec::new();
        if self.sc.peek() == Some(':') {
            self.sc.advance();
            base_types = self.sc.read_base_types();
        }
        // Skip `where` constraints
        loop {
            self.sc.skip_trivia();
            if matches!(self.sc.peek(), Some(c) if c.is_alphabetic()) {
                // Peek to see if it's "where"
                let saved_pos = self.sc.pos;
                let saved_line = self.sc.line;
                let saved_col = self.sc.col;
                let w = self.sc.read_ident();
                if w == "where" {
                    while !matches!(self.sc.peek(), Some('{') | Some(';') | None) {
                        self.sc.advance();
                    }
                } else {
                    // Restore
                    self.sc.pos = saved_pos;
                    self.sc.line = saved_line;
                    self.sc.col = saved_col;
                    break;
                }
            } else { break; }
        }
        self.sc.skip_trivia();

        let kind = match keyword {
            "struct" => SymbolKind::Struct,
            "record" => SymbolKind::Record,
            "interface" => SymbolKind::Interface,
            _ => SymbolKind::Class,
        };

        let sym_id = self.make_id(&name);
        let parent_id = self.type_stack.last().map(|n| self.make_id(n));

        let sym = CSharpSymbol {
            id: sym_id.clone(),
            kind,
            name: name.clone(),
            namespace: self.namespace.clone(),
            return_type: None,
            parameters: vec![],
            base_types,
            modifiers: mods,
            range: TextRange { start, end: self.sc.current_pos() },
            file: self.file.clone(),
            children: vec![],
        };
        self.out.push(sym);

        if let Some(pid) = parent_id {
            if let Some(p) = self.out.iter_mut().find(|s| s.id == pid) {
                p.children.push(sym_id.clone());
            }
        }

        if self.sc.peek() == Some('{') {
            self.sc.advance();
            self.type_stack.push(name);
            loop {
                self.sc.skip_trivia();
                if self.sc.at_end() { break; }
                if self.sc.peek() == Some('}') { self.sc.advance(); break; }
                self.parse_decl();
            }
            self.type_stack.pop();
        } else {
            self.sc.skip_to_semi_or_block();
        }
    }

    fn parse_enum(&mut self, mods: Vec<String>, start: TextPosition) {
        self.sc.skip_trivia();
        let name = self.sc.read_ident();
        if name.is_empty() { self.sc.skip_to_semi_or_block(); return; }

        self.sc.skip_trivia();
        if self.sc.peek() == Some(':') { self.sc.advance(); self.sc.read_type_str(); }
        self.sc.skip_trivia();

        let enum_id = self.make_id(&name);
        let parent_id = self.type_stack.last().map(|n| self.make_id(n));

        self.out.push(CSharpSymbol {
            id: enum_id.clone(),
            kind: SymbolKind::Enum,
            name: name.clone(),
            namespace: self.namespace.clone(),
            return_type: None, parameters: vec![], base_types: vec![],
            modifiers: mods,
            range: TextRange { start, end: self.sc.current_pos() },
            file: self.file.clone(), children: vec![],
        });
        if let Some(pid) = parent_id {
            if let Some(p) = self.out.iter_mut().find(|s| s.id == pid) {
                p.children.push(enum_id.clone());
            }
        }

        if self.sc.peek() != Some('{') { self.sc.skip_to_semi_or_block(); return; }
        self.sc.advance();
        self.type_stack.push(name);
        loop {
            self.sc.skip_trivia();
            match self.sc.peek() {
                None | Some('}') => { self.sc.advance(); break; }
                Some('[') => { self.sc.advance(); self.sc.skip_balanced('[', ']'); }
                _ => {
                    let ms = self.sc.current_pos();
                    let mn = self.sc.read_ident();
                    if mn.is_empty() { self.sc.advance(); continue; }
                    let mid = self.make_id(&mn);
                    let m = CSharpSymbol {
                        id: mid.clone(), kind: SymbolKind::EnumMember, name: mn.clone(),
                        namespace: self.namespace.clone(),
                        return_type: None, parameters: vec![], base_types: vec![], modifiers: vec![],
                        range: TextRange { start: ms, end: self.sc.current_pos() },
                        file: self.file.clone(), children: vec![],
                    };
                    if let Some(e) = self.out.iter_mut().find(|s| s.id == enum_id) {
                        e.children.push(mid.clone());
                    }
                    self.out.push(m);
                    // skip optional `= val,`
                    self.sc.skip_trivia();
                    if self.sc.peek() == Some('=') {
                        while !matches!(self.sc.peek(), Some(',') | Some('}') | None) { self.sc.advance(); }
                    }
                    self.sc.skip_trivia();
                    if self.sc.peek() == Some(',') { self.sc.advance(); }
                }
            }
        }
        self.type_stack.pop();
    }

    fn parse_event(&mut self, mods: Vec<String>, start: TextPosition) {
        self.sc.skip_trivia();
        let ty = self.sc.read_type_str();
        self.sc.skip_trivia();
        let name = self.sc.read_ident();
        if name.is_empty() { self.sc.skip_to_semi_or_block(); return; }
        let id = self.make_id(&name);
        let parent_id = self.type_stack.last().map(|n| self.make_id(n));
        let sym = CSharpSymbol {
            id: id.clone(), kind: SymbolKind::Event, name,
            namespace: self.namespace.clone(),
            return_type: Some(TypeRef::simple(ty)), parameters: vec![], base_types: vec![],
            modifiers: mods,
            range: TextRange { start, end: self.sc.current_pos() },
            file: self.file.clone(), children: vec![],
        };
        if let Some(pid) = parent_id {
            if let Some(p) = self.out.iter_mut().find(|s| s.id == pid) {
                p.children.push(id);
            }
        }
        self.out.push(sym);
        self.sc.skip_to_semi_or_block();
    }

    fn parse_member_after_type(&mut self, return_type: &str, mods: Vec<String>, start: TextPosition) {
        self.sc.skip_trivia();
        let name = self.sc.read_ident();
        if name.is_empty() { self.sc.skip_to_semi_or_block(); return; }

        let enclosing = self.type_stack.last().map(|s| s.as_str()).unwrap_or("").to_string();
        self.sc.skip_trivia();

        // Generic method `<T>`
        if self.sc.peek() == Some('<') {
            self.sc.advance();
            self.sc.skip_balanced('<', '>');
            self.sc.skip_trivia();
        }

        let is_ctor = name == enclosing && return_type == enclosing;
        let kind = if is_ctor { SymbolKind::Constructor }
                   else if self.sc.peek() == Some('(') { SymbolKind::Method }
                   else if self.sc.peek() == Some('{') || self.sc.peek() == Some(';') || self.sc.peek() == Some('=') { SymbolKind::Property }
                   else { SymbolKind::Field };

        let params = if matches!(kind, SymbolKind::Method | SymbolKind::Constructor) {
            if self.sc.peek() == Some('(') {
                self.sc.advance();
                self.sc.read_params()
            } else { vec![] }
        } else { vec![] };

        // For property with auto-body { get; set; } we need to skip it.
        let id = self.make_id(&name);
        let parent_id = self.type_stack.last().map(|n| self.make_id(n));

        let sym = CSharpSymbol {
            id: id.clone(),
            kind: kind.clone(),
            name: name.clone(),
            namespace: self.namespace.clone(),
            return_type: if matches!(kind, SymbolKind::Constructor) { None }
                        else { Some(TypeRef::simple(return_type)) },
            parameters: params,
            base_types: vec![],
            modifiers: mods,
            range: TextRange { start, end: self.sc.current_pos() },
            file: self.file.clone(),
            children: vec![],
        };
        if let Some(pid) = parent_id {
            if let Some(p) = self.out.iter_mut().find(|s| s.id == pid) {
                p.children.push(id);
            }
        }
        self.out.push(sym);
        self.sc.skip_to_semi_or_block();
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Extrai todos os símbolos declarados em `src` (texto C#).
pub fn parse_csharp_symbols(src: &str, file: &Path) -> Vec<CSharpSymbol> {
    let mut p = Parser::new(src, file.to_path_buf());
    p.parse_all();
    p.out
}

// ── Índice global ─────────────────────────────────────────────────────────────

pub struct SymbolIndex {
    by_file: HashMap<PathBuf, Vec<CSharpSymbol>>,
    by_name: HashMap<String, Vec<String>>,
    by_id: HashMap<String, CSharpSymbol>,
}

impl SymbolIndex {
    pub fn new() -> Self {
        SymbolIndex { by_file: HashMap::new(), by_name: HashMap::new(), by_id: HashMap::new() }
    }

    pub fn index_file(&mut self, path: &Path, src: &str) {
        self.remove_file(path);
        let symbols = parse_csharp_symbols(src, path);
        let mut file_syms = Vec::new();
        for sym in symbols {
            let fq = sym.id.splitn(2, "::").nth(1).unwrap_or(&sym.name).to_string();
            self.by_name.entry(fq).or_default().push(sym.id.clone());
            self.by_name.entry(sym.name.clone()).or_default().push(sym.id.clone());
            self.by_id.insert(sym.id.clone(), sym.clone());
            file_syms.push(sym);
        }
        self.by_file.insert(path.to_path_buf(), file_syms);
    }

    pub fn remove_file(&mut self, path: &Path) {
        if let Some(old) = self.by_file.remove(path) {
            for sym in old {
                self.by_id.remove(&sym.id);
                let fq = sym.id.splitn(2, "::").nth(1).unwrap_or(&sym.name).to_string();
                for key in [fq, sym.name] {
                    if let Some(ids) = self.by_name.get_mut(&key) {
                        ids.retain(|id| id != &sym.id);
                        if ids.is_empty() { self.by_name.remove(&key); }
                    }
                }
            }
        }
    }

    pub fn resolve(&self, name: &str) -> Resolution {
        let ids = match self.by_name.get(name) {
            None => return Resolution::Unknown,
            Some(ids) => ids,
        };
        let syms: Vec<CSharpSymbol> = ids.iter()
            .filter_map(|id| self.by_id.get(id).cloned()).collect();
        match syms.len() {
            0 => Resolution::Unknown,
            1 => Resolution::Resolved(syms.into_iter().next().unwrap()),
            _ => Resolution::Ambiguous(syms),
        }
    }

    pub fn symbols_for_file(&self, path: &Path) -> &[CSharpSymbol] {
        self.by_file.get(path).map(|v| v.as_slice()).unwrap_or(&[])
    }

    pub fn file_count(&self) -> usize { self.by_file.len() }
    pub fn symbol_count(&self) -> usize { self.by_id.len() }
}

impl Default for SymbolIndex {
    fn default() -> Self { Self::new() }
}

// ── Testes ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_CLASS: &str = r#"
namespace MyApp.Models
{
    public class Product
    {
        public int Id { get; set; }
        public string Name { get; set; }
        public decimal Price { get; set; }

        public Product(int id, string name)
        {
        }

        public void UpdatePrice(decimal newPrice)
        {
        }
    }
}
"#;

    const FIXTURE_ENUM: &str = r#"
namespace MyApp.Enums
{
    public enum Status
    {
        Active,
        Inactive,
        Pending
    }
}
"#;

    const FIXTURE_INTERFACE: &str = r#"
namespace MyApp.Interfaces
{
    public interface IProductService
    {
        Product GetById(int id);
        void Update(Product product);
    }
}
"#;

    const FIXTURE_FILE_NS: &str = r#"
namespace MyApp.Pages;

public class IndexModel
{
    public string Title { get; set; }
}
"#;

    fn file() -> PathBuf { PathBuf::from("test.cs") }

    fn parse(src: &str) -> Vec<CSharpSymbol> {
        parse_csharp_symbols(src, &file())
    }

    fn of_kind<'a>(syms: &'a [CSharpSymbol], k: &SymbolKind) -> Vec<&'a CSharpSymbol> {
        syms.iter().filter(|s| &s.kind == k).collect()
    }

    // ── No-panic ──────────────────────────────────────────────────────────────

    #[test]
    fn no_panic_empty() { let _ = parse(""); }

    #[test]
    fn no_panic_partial() { let _ = parse("public class Foo {"); }

    #[test]
    fn no_panic_strings_comments() {
        let _ = parse("// comment\n/* block */\npublic class Bar { string s = \"hello { }\"; }");
    }

    // ── Namespace ─────────────────────────────────────────────────────────────

    #[test]
    fn extracts_namespace() {
        let syms = parse(FIXTURE_CLASS);
        let classes = of_kind(&syms, &SymbolKind::Class);
        assert!(!classes.is_empty());
        assert_eq!(classes[0].namespace, "MyApp.Models");
    }

    #[test]
    fn file_scoped_namespace() {
        let syms = parse(FIXTURE_FILE_NS);
        let classes = of_kind(&syms, &SymbolKind::Class);
        assert!(!classes.is_empty(), "must find IndexModel");
        assert_eq!(classes[0].namespace, "MyApp.Pages");
        assert_eq!(classes[0].name, "IndexModel");
    }

    // ── Class members ─────────────────────────────────────────────────────────

    #[test]
    fn extracts_class() {
        let syms = parse(FIXTURE_CLASS);
        let classes = of_kind(&syms, &SymbolKind::Class);
        assert!(!classes.is_empty());
        assert_eq!(classes[0].name, "Product");
    }

    #[test]
    fn extracts_properties() {
        let syms = parse(FIXTURE_CLASS);
        let props = of_kind(&syms, &SymbolKind::Property);
        let names: Vec<_> = props.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"Id"), "must find Id");
        assert!(names.contains(&"Name"), "must find Name");
        assert!(names.contains(&"Price"), "must find Price");
    }

    #[test]
    fn extracts_method() {
        let syms = parse(FIXTURE_CLASS);
        let methods = of_kind(&syms, &SymbolKind::Method);
        let names: Vec<_> = methods.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains(&"UpdatePrice"), "must find UpdatePrice");
    }

    #[test]
    fn method_has_params() {
        let syms = parse(FIXTURE_CLASS);
        let m = of_kind(&syms, &SymbolKind::Method)
            .into_iter().find(|m| m.name == "UpdatePrice")
            .expect("UpdatePrice must exist");
        assert_eq!(m.parameters.len(), 1);
        assert_eq!(m.parameters[0].0, "newPrice");
    }

    // ── Enum ──────────────────────────────────────────────────────────────────

    #[test]
    fn extracts_enum() {
        let syms = parse(FIXTURE_ENUM);
        let enums = of_kind(&syms, &SymbolKind::Enum);
        assert!(!enums.is_empty());
        assert_eq!(enums[0].name, "Status");
    }

    #[test]
    fn extracts_enum_members() {
        let syms = parse(FIXTURE_ENUM);
        let members = of_kind(&syms, &SymbolKind::EnumMember);
        let names: Vec<_> = members.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains(&"Active") && names.contains(&"Inactive") && names.contains(&"Pending"));
    }

    // ── Interface ─────────────────────────────────────────────────────────────

    #[test]
    fn extracts_interface() {
        let syms = parse(FIXTURE_INTERFACE);
        let ifaces = of_kind(&syms, &SymbolKind::Interface);
        assert!(!ifaces.is_empty());
        assert_eq!(ifaces[0].name, "IProductService");
    }

    // ── SymbolIndex ───────────────────────────────────────────────────────────

    #[test]
    fn index_and_resolve() {
        let mut idx = SymbolIndex::new();
        idx.index_file(&file(), FIXTURE_CLASS);
        assert!(idx.file_count() == 1 && idx.symbol_count() > 0);
        assert!(matches!(idx.resolve("Product"), Resolution::Resolved(s) if s.kind == SymbolKind::Class));
    }

    #[test]
    fn resolve_unknown() {
        assert!(matches!(SymbolIndex::new().resolve("NoSuch"), Resolution::Unknown));
    }

    #[test]
    fn incremental_reindex() {
        let mut idx = SymbolIndex::new();
        idx.index_file(&file(), "namespace A { public class Foo {} }");
        assert!(matches!(idx.resolve("Foo"), Resolution::Resolved(_)));
        idx.index_file(&file(), "namespace A { public class Bar {} }");
        assert!(matches!(idx.resolve("Foo"), Resolution::Unknown));
        assert!(matches!(idx.resolve("Bar"), Resolution::Resolved(_)));
    }

    #[test]
    fn remove_file() {
        let mut idx = SymbolIndex::new();
        idx.index_file(&file(), FIXTURE_CLASS);
        idx.remove_file(&file());
        assert_eq!(idx.symbol_count(), 0);
    }

    #[test]
    fn ambiguous_same_simple_name() {
        let mut idx = SymbolIndex::new();
        idx.index_file(&PathBuf::from("a.cs"), "namespace A { public class Foo {} }");
        idx.index_file(&PathBuf::from("b.cs"), "namespace B { public class Foo {} }");
        assert!(matches!(idx.resolve("Foo"), Resolution::Ambiguous(_)));
    }

    #[test]
    fn qualified_resolves_unambiguously() {
        let mut idx = SymbolIndex::new();
        idx.index_file(&PathBuf::from("a.cs"), "namespace A { public class Foo {} }");
        idx.index_file(&PathBuf::from("b.cs"), "namespace B { public class Foo {} }");
        assert!(matches!(idx.resolve("A.Foo"), Resolution::Resolved(_)));
        assert!(matches!(idx.resolve("B.Foo"), Resolution::Resolved(_)));
    }

    #[test]
    fn symbols_for_file() {
        let mut idx = SymbolIndex::new();
        idx.index_file(&file(), FIXTURE_CLASS);
        let syms = idx.symbols_for_file(&file());
        assert!(!syms.is_empty());
        assert!(syms.iter().any(|s| s.name == "Product"));
    }
}
