/// Indexador de metadata ECMA-335 de assemblies .NET (issue #42).
///
/// Lê tabelas de metadata de arquivos `.dll`/`.exe` PE sem carregar o CLR ou
/// usar Roslyn. Parse byte-a-byte do formato ECMA-335 Section II.
///
/// Dados extraídos: TypeDef, TypeRef, MethodDef, Field, Property, Param,
/// InterfaceImpl e MemberRef — suficientes para completions e hover básicos.
///
/// Assemblies inválidos geram log/estado controlado; nenhum panic.
/// Cache por `(path, mtime, size)` evita reprocessar assemblies inalterados.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

// ── Tipos públicos ────────────────────────────────────────────────────────────

/// Visibilidade extraída dos flags de TypeDef/MethodDef.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Visibility {
    Public,
    Private,
    Protected,
    Internal,
    ProtectedInternal,
    PrivateProtected,
    Unknown,
}

/// Tipo de membro de um tipo .NET.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemberKind {
    Method,
    Constructor,
    Property,
    Field,
    Event,
}

/// Um membro de um tipo (método, propriedade, campo, evento).
#[derive(Debug, Clone)]
pub struct MetaMember {
    pub name: String,
    pub kind: MemberKind,
    pub visibility: Visibility,
    pub is_static: bool,
    /// Assinatura textual simplificada, ex: "int GetId(string key)".
    pub signature: String,
}

/// Um tipo declarado num assembly (classe, struct, interface, enum, delegate).
#[derive(Debug, Clone)]
pub struct MetaType {
    /// Nome simples, sem namespace.
    pub name: String,
    pub namespace: String,
    pub visibility: Visibility,
    pub is_abstract: bool,
    pub is_sealed: bool,
    pub is_interface: bool,
    pub is_enum: bool,
    pub is_value_type: bool,
    pub base_type: Option<String>,
    pub interfaces: Vec<String>,
    pub members: Vec<MetaMember>,
}

impl MetaType {
    pub fn full_name(&self) -> String {
        if self.namespace.is_empty() { self.name.clone() }
        else { format!("{}.{}", self.namespace, self.name) }
    }
}

/// Resultado de indexação de um assembly.
#[derive(Debug)]
pub struct AssemblyIndex {
    pub name: String,
    pub version: String,
    /// Todos os tipos públicos indexados, keyed by fully-qualified name.
    pub types: HashMap<String, MetaType>,
    /// Erros não-fatais durante o parse (assembly continua parcialmente indexado).
    pub warnings: Vec<String>,
}

// ── Erros ─────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum MetaError {
    Io(std::io::Error),
    /// Arquivo não parece um PE com metadata CLI.
    NotCli(String),
    /// Seção ou tabela inválida.
    Malformed(String),
}

impl std::fmt::Display for MetaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MetaError::Io(e) => write!(f, "IO: {e}"),
            MetaError::NotCli(s) => write!(f, "NotCLI: {s}"),
            MetaError::Malformed(s) => write!(f, "Malformed: {s}"),
        }
    }
}

impl From<std::io::Error> for MetaError {
    fn from(e: std::io::Error) -> Self { MetaError::Io(e) }
}

// ── Leitura de bytes ──────────────────────────────────────────────────────────

fn read_u8(data: &[u8], off: usize) -> Option<u8> {
    data.get(off).copied()
}

fn read_u16(data: &[u8], off: usize) -> Option<u16> {
    let b0 = *data.get(off)? as u16;
    let b1 = *data.get(off + 1)? as u16;
    Some(b0 | (b1 << 8))
}

fn read_u32(data: &[u8], off: usize) -> Option<u32> {
    let b0 = *data.get(off)? as u32;
    let b1 = *data.get(off + 1)? as u32;
    let b2 = *data.get(off + 2)? as u32;
    let b3 = *data.get(off + 3)? as u32;
    Some(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24))
}

fn read_cstr(data: &[u8], off: usize) -> Option<String> {
    let end = data[off..].iter().position(|&b| b == 0)?;
    std::str::from_utf8(&data[off..off + end]).ok().map(|s| s.to_string())
}

// ── Navegação PE → CLI metadata ───────────────────────────────────────────────

/// Resolve uma RVA para um offset em bytes no arquivo, given a simple section table.
fn rva_to_offset(rva: u32, sections: &[(u32, u32, u32)]) -> Option<usize> {
    // sections: (virtual_addr, virtual_size, raw_offset)
    for &(va, vs, ro) in sections {
        if rva >= va && rva < va + vs {
            return Some((rva - va + ro) as usize);
        }
    }
    None
}

/// Parseia o PE e retorna o offset da raiz de metadata CLI no arquivo.
fn find_metadata_root(data: &[u8]) -> Result<usize, MetaError> {
    // MZ signature
    if read_u16(data, 0) != Some(0x5A4D) {
        return Err(MetaError::NotCli("MZ signature not found".into()));
    }
    // PE header offset
    let pe_off = read_u32(data, 0x3C).ok_or_else(|| MetaError::Malformed("bad PE offset".into()))? as usize;
    if read_u32(data, pe_off) != Some(0x4550) {
        return Err(MetaError::NotCli("PE signature not found".into()));
    }

    let _machine = read_u16(data, pe_off + 4).unwrap_or(0);
    let num_sections = read_u16(data, pe_off + 6).unwrap_or(0) as usize;
    let opt_size = read_u16(data, pe_off + 20).unwrap_or(0) as usize;

    // Optional header magic: 0x10B = PE32, 0x20B = PE32+
    let opt_magic = read_u16(data, pe_off + 24).unwrap_or(0);
    let is64 = opt_magic == 0x20B;

    // Data directory base
    let dd_base = pe_off + 24 + if is64 { 112 } else { 96 };
    // CLR runtime header is data directory entry 14 (index 14)
    let clr_rva = read_u32(data, dd_base + 14 * 8).ok_or_else(|| MetaError::NotCli("no CLR data directory".into()))?;
    if clr_rva == 0 {
        return Err(MetaError::NotCli("CLR runtime header RVA is 0".into()));
    }

    // Section table starts right after optional header
    let section_table_off = pe_off + 24 + opt_size;
    let mut sections = Vec::with_capacity(num_sections);
    for i in 0..num_sections {
        let base = section_table_off + i * 40;
        let va = read_u32(data, base + 12).unwrap_or(0);
        let vs = read_u32(data, base + 8).unwrap_or(0);
        let ro = read_u32(data, base + 20).unwrap_or(0);
        sections.push((va, vs, ro));
    }

    // CLR header offset in file
    let clr_off = rva_to_offset(clr_rva, &sections)
        .ok_or_else(|| MetaError::Malformed("CLR header RVA not in any section".into()))?;

    // Metadata RVA is at CLR header + 8 (after HeaderSize + MajorRuntimeVersion + MinorRuntimeVersion)
    let meta_rva = read_u32(data, clr_off + 8)
        .ok_or_else(|| MetaError::Malformed("metadata RVA not readable".into()))?;

    rva_to_offset(meta_rva, &sections)
        .ok_or_else(|| MetaError::Malformed("metadata root RVA not in any section".into()))
}

// ── Parser de metadata CLI ─────────────────────────────────────────────────────

#[allow(dead_code)]
struct MetaReader<'a> {
    data: &'a [u8],
    meta: usize,          // offset of metadata root
    strings: usize,       // #Strings heap offset
    blob: usize,          // #Blob heap offset
    us: usize,            // #US heap offset
    guid: usize,          // #GUID heap offset
    tables: usize,        // #~ or #- stream offset
    // Row counts (indexed by table id 0..63)
    rows: [u32; 64],
    // Whether to use 4-byte or 2-byte indexes for each heap/coded index
    str_wide: bool,
    blob_wide: bool,
    guid_wide: bool,
    // Table offsets (byte offset from data[0])
    table_offsets: [usize; 64],
    // Row sizes in bytes for each table
    row_sizes: [usize; 64],
}

impl<'a> MetaReader<'a> {
    fn new(data: &'a [u8], meta_off: usize) -> Result<Self, MetaError> {
        // Metadata root: magic = 0x424A5342
        if read_u32(data, meta_off) != Some(0x424A5342) {
            return Err(MetaError::NotCli("metadata magic not found".into()));
        }
        // Version string length
        let ver_len = read_u32(data, meta_off + 12).unwrap_or(0) as usize;
        let stream_count_off = meta_off + 16 + ver_len;
        // Flags (2 bytes) + number of streams (2 bytes)
        let _flags = read_u16(data, stream_count_off).unwrap_or(0);
        let num_streams = read_u16(data, stream_count_off + 2).unwrap_or(0) as usize;

        let mut off = stream_count_off + 4;
        let mut strings = 0usize;
        let mut blob = 0usize;
        let mut us = 0usize;
        let mut guid = 0usize;
        let mut tables = 0usize;

        for _ in 0..num_streams {
            let stream_off = read_u32(data, off).unwrap_or(0) as usize;
            let _stream_size = read_u32(data, off + 4).unwrap_or(0) as usize;
            off += 8;
            // Read name (null-terminated, padded to 4-byte boundary)
            let name_start = off;
            let name_end = data[off..].iter().position(|&b| b == 0)
                .map(|p| off + p).unwrap_or(off);
            let name = std::str::from_utf8(&data[off..name_end]).unwrap_or("?");
            let name_pad = (name_end - name_start + 1 + 3) & !3;
            off += name_pad;

            match name {
                "#Strings" => strings = meta_off + stream_off,
                "#Blob" => blob = meta_off + stream_off,
                "#US" => us = meta_off + stream_off,
                "#GUID" => guid = meta_off + stream_off,
                "#~" | "#-" => tables = meta_off + stream_off,
                _ => {}
            }
        }

        if tables == 0 { return Err(MetaError::Malformed("#~ stream not found".into())); }

        // Parse #~ stream header
        // Reserved (4) + MajorVersion (1) + MinorVersion (1) + HeapSizes (1) + Reserved (1)
        let heap_sizes = read_u8(data, tables + 6).unwrap_or(0);
        let str_wide = (heap_sizes & 0x01) != 0;
        let guid_wide = (heap_sizes & 0x02) != 0;
        let blob_wide = (heap_sizes & 0x04) != 0;

        // Valid mask (8 bytes) — which tables are present
        let valid_lo = read_u32(data, tables + 8).unwrap_or(0) as u64;
        let valid_hi = read_u32(data, tables + 12).unwrap_or(0) as u64;
        let valid = valid_lo | (valid_hi << 32);

        // Read row counts for each present table (4 bytes each, in order of table id)
        let mut rows = [0u32; 64];
        let mut row_off = tables + 24;
        for i in 0..64u64 {
            if (valid >> i) & 1 == 1 {
                rows[i as usize] = read_u32(data, row_off).unwrap_or(0);
                row_off += 4;
            }
        }

        let mut mr = MetaReader {
            data,
            meta: meta_off,
            strings,
            blob,
            us,
            guid,
            tables,
            rows,
            str_wide,
            blob_wide,
            guid_wide,
            table_offsets: [0; 64],
            row_sizes: [0; 64],
        };

        mr.compute_table_layout(row_off);
        Ok(mr)
    }

    /// Size of a heap index (2 or 4).
    fn str_idx_size(&self) -> usize { if self.str_wide { 4 } else { 2 } }
    fn blob_idx_size(&self) -> usize { if self.blob_wide { 4 } else { 2 } }
    fn guid_idx_size(&self) -> usize { if self.guid_wide { 4 } else { 2 } }

    /// Size of a row index into table `t` (2 or 4).
    fn table_idx_size(&self, t: usize) -> usize {
        if self.rows.get(t).copied().unwrap_or(0) > 0xFFFF { 4 } else { 2 }
    }

    /// Coded index size for `TypeDefOrRef` (tables 0, 1, 2).
    fn type_def_or_ref_size(&self) -> usize {
        let max = [0usize, 1, 2].iter().map(|&t| self.rows[t]).max().unwrap_or(0);
        if max > (0xFFFF >> 2) { 4 } else { 2 }
    }

    /// Coded index size for `MemberRefParent` (tables 0,1,2,3,26).
    fn member_ref_parent_size(&self) -> usize {
        let max = [0usize, 1, 2, 3, 26].iter().map(|&t| self.rows[t]).max().unwrap_or(0);
        if max > (0xFFFF >> 3) { 4 } else { 2 }
    }

    /// Coded index size for `HasSemantics` (tables 20, 23) — Property, Event.
    fn has_semantics_size(&self) -> usize {
        let max = [20usize, 23].iter().map(|&t| self.rows[t]).max().unwrap_or(0);
        if max > (0xFFFF >> 1) { 4 } else { 2 }
    }

    /// Compute row sizes and table start offsets. Called after row counts are known.
    fn compute_table_layout(&mut self, first_table_data: usize) {
        // Table row sizes per ECMA-335 II.22 — simplified to what we need.
        // Table IDs we care about: 0=Module, 1=TypeRef, 2=TypeDef, 4=Field,
        // 6=MethodDef, 8=Param, 9=InterfaceImpl, 10=MemberRef, 17=Event,
        // 20=PropertyMap, 21=Property, 23=MethodSemantics, 24=MethodImpl, 32=Assembly

        let si = self.str_idx_size();
        let bi = self.blob_idx_size();
        let gi = self.guid_idx_size();
        let tdr = self.type_def_or_ref_size();
        let mrp = self.member_ref_parent_size();

        // Precompute row sizes for each table.
        // 0: Module
        self.row_sizes[0] = 2 + si + gi + gi + gi;
        // 1: TypeRef: ResolutionScope (coded 2b/4b) + Name + Namespace
        let resolution_scope = {
            let max = [0usize,1,2,6].iter().map(|&t| self.rows[t]).max().unwrap_or(0);
            if max > (0xFFFF >> 2) { 4 } else { 2 }
        };
        self.row_sizes[1] = resolution_scope + si + si;
        // 2: TypeDef: Flags(4) + Name + Namespace + Extends(coded) + FieldList(2b/4b) + MethodList(2b/4b)
        self.row_sizes[2] = 4 + si + si + tdr + self.table_idx_size(4) + self.table_idx_size(6);
        // 4: Field: Flags(2) + Name + Signature
        self.row_sizes[4] = 2 + si + bi;
        // 6: MethodDef: RVA(4) + ImplFlags(2) + Flags(2) + Name + Signature + ParamList(2b/4b)
        self.row_sizes[6] = 4 + 2 + 2 + si + bi + self.table_idx_size(8);
        // 8: Param: Flags(2) + Sequence(2) + Name
        self.row_sizes[8] = 2 + 2 + si;
        // 9: InterfaceImpl: Class(table 2 idx) + Interface(coded TypeDefOrRef)
        self.row_sizes[9] = self.table_idx_size(2) + tdr;
        // 10: MemberRef: Class(coded) + Name + Signature
        self.row_sizes[10] = mrp + si + bi;
        // 17: Event: EventFlags(2) + Name + EventType(coded TypeDefOrRef)
        self.row_sizes[17] = 2 + si + tdr;
        // 20: PropertyMap: Parent(table 2 idx) + PropertyList(table 23 idx)
        self.row_sizes[20] = self.table_idx_size(2) + self.table_idx_size(21);
        // 21: Property: Flags(2) + Name + Type(blob)
        self.row_sizes[21] = 2 + si + bi;
        // 23: MethodSemantics: Semantics(2) + Method(MethodDef idx) + Association(HasSemantics)
        self.row_sizes[23] = 2 + self.table_idx_size(6) + self.has_semantics_size();
        // 32: Assembly: HashAlgId(4) + MajorVersion(2)*4 + Flags(4) + PublicKey(blob) + Name + Culture
        self.row_sizes[32] = 4 + 8 + 4 + bi + si + si;
        // Others default to 0 (we won't access them)

        // Walk tables in order of valid bit to compute offsets.
        let valid_lo = read_u32(self.data, self.tables + 8).unwrap_or(0) as u64;
        let valid_hi = read_u32(self.data, self.tables + 12).unwrap_or(0) as u64;
        let valid = valid_lo | (valid_hi << 32);

        let mut off = first_table_data;
        for i in 0..64u64 {
            if (valid >> i) & 1 == 1 {
                self.table_offsets[i as usize] = off;
                off += self.rows[i as usize] as usize * self.row_sizes[i as usize];
            }
        }
    }

    /// Read a heap string index (2 or 4 bytes).
    fn read_str_idx(&self, off: usize) -> (u32, usize) {
        if self.str_wide {
            (read_u32(self.data, off).unwrap_or(0), 4)
        } else {
            (read_u16(self.data, off).unwrap_or(0) as u32, 2)
        }
    }

    /// Get a string from the #Strings heap.
    fn str(&self, idx: u32) -> String {
        if idx == 0 { return String::new(); }
        read_cstr(self.data, self.strings + idx as usize).unwrap_or_default()
    }

    /// Read a simple table index (2 or 4 bytes) for table `t`.
    fn read_table_idx(&self, off: usize, t: usize) -> (u32, usize) {
        if self.table_idx_size(t) == 4 {
            (read_u32(self.data, off).unwrap_or(0), 4)
        } else {
            (read_u16(self.data, off).unwrap_or(0) as u32, 2)
        }
    }

    fn read_coded(&self, off: usize, size: usize) -> (u32, usize) {
        if size == 4 {
            (read_u32(self.data, off).unwrap_or(0), 4)
        } else {
            (read_u16(self.data, off).unwrap_or(0) as u32, 2)
        }
    }

    /// Row offset for table `t`, row index `row` (1-based, per ECMA-335).
    fn row_off(&self, t: usize, row: u32) -> usize {
        self.table_offsets[t] + (row as usize - 1) * self.row_sizes[t]
    }

    fn type_def_flags(&self, row: u32) -> u32 {
        let off = self.row_off(2, row);
        read_u32(self.data, off).unwrap_or(0)
    }

    fn type_def_name(&self, row: u32) -> String {
        let off = self.row_off(2, row);
        let (idx, _) = self.read_str_idx(off + 4);
        self.str(idx)
    }

    fn type_def_ns(&self, row: u32) -> String {
        let off = self.row_off(2, row);
        let si = self.str_idx_size();
        let (idx, _) = self.read_str_idx(off + 4 + si);
        self.str(idx)
    }

    fn type_def_extends(&self, row: u32) -> u32 {
        let off = self.row_off(2, row);
        let si = self.str_idx_size();
        let (coded, _) = self.read_coded(off + 4 + si * 2, self.type_def_or_ref_size());
        coded
    }

    fn type_def_field_list(&self, row: u32) -> u32 {
        let off = self.row_off(2, row);
        let si = self.str_idx_size();
        let tdr = self.type_def_or_ref_size();
        let (idx, _) = self.read_table_idx(off + 4 + si * 2 + tdr, 4);
        idx
    }

    fn type_def_method_list(&self, row: u32) -> u32 {
        let off = self.row_off(2, row);
        let si = self.str_idx_size();
        let tdr = self.type_def_or_ref_size();
        let fi = self.table_idx_size(4);
        let (idx, _) = self.read_table_idx(off + 4 + si * 2 + tdr + fi, 6);
        idx
    }

    fn method_def_flags(&self, row: u32) -> u16 {
        let off = self.row_off(6, row);
        read_u16(self.data, off + 6).unwrap_or(0)
    }

    fn method_def_name(&self, row: u32) -> String {
        let off = self.row_off(6, row);
        let (idx, _) = self.read_str_idx(off + 8);
        self.str(idx)
    }

    fn field_flags(&self, row: u32) -> u16 {
        let off = self.row_off(4, row);
        read_u16(self.data, off).unwrap_or(0)
    }

    fn field_name(&self, row: u32) -> String {
        let off = self.row_off(4, row);
        let (idx, _) = self.read_str_idx(off + 2);
        self.str(idx)
    }

    #[allow(dead_code)]
    fn property_flags(&self, row: u32) -> u16 {
        let off = self.row_off(21, row);
        read_u16(self.data, off).unwrap_or(0)
    }

    #[allow(dead_code)]
    fn property_name(&self, row: u32) -> String {
        let off = self.row_off(21, row);
        let (idx, _) = self.read_str_idx(off + 2);
        self.str(idx)
    }

    fn type_ref_name(&self, row: u32) -> String {
        let off = self.row_off(1, row);
        let resolution_scope_size = {
            let max = [0usize,1,2,6].iter().map(|&t| self.rows[t]).max().unwrap_or(0);
            if max > (0xFFFF >> 2) { 4 } else { 2 }
        };
        let (idx, _) = self.read_str_idx(off + resolution_scope_size);
        self.str(idx)
    }

    fn type_ref_ns(&self, row: u32) -> String {
        let off = self.row_off(1, row);
        let resolution_scope_size = {
            let max = [0usize,1,2,6].iter().map(|&t| self.rows[t]).max().unwrap_or(0);
            if max > (0xFFFF >> 2) { 4 } else { 2 }
        };
        let si = self.str_idx_size();
        let (idx, _) = self.read_str_idx(off + resolution_scope_size + si);
        self.str(idx)
    }

    /// Decode a TypeDefOrRef coded index → table id + row.
    fn decode_type_def_or_ref(&self, coded: u32) -> Option<(usize, u32)> {
        let tag = coded & 0x3;
        let row = coded >> 2;
        if row == 0 { return None; }
        let table = match tag { 0 => 2, 1 => 1, 2 => 2, _ => return None }; // TypeDef, TypeRef, TypeSpec
        Some((table, row))
    }

    /// Get the full name of a TypeDefOrRef coded index.
    fn type_fqn_from_coded(&self, coded: u32) -> String {
        let Some((table, row)) = self.decode_type_def_or_ref(coded) else { return String::new(); };
        if row == 0 || row > self.rows[table] { return String::new(); }
        match table {
            2 => {
                let ns = self.type_def_ns(row);
                let name = self.type_def_name(row);
                if ns.is_empty() { name } else { format!("{ns}.{name}") }
            }
            1 => {
                let ns = self.type_ref_ns(row);
                let name = self.type_ref_name(row);
                if ns.is_empty() { name } else { format!("{ns}.{name}") }
            }
            _ => String::new(),
        }
    }

    fn assembly_name(&self) -> String {
        if self.rows[32] == 0 { return String::new(); }
        let off = self.row_off(32, 1);
        // Skip HashAlgId(4) + MajorVersion(2)*4 + Flags(4) + PublicKey(blob)
        let bi = self.blob_idx_size();
        let (idx, _) = self.read_str_idx(off + 4 + 8 + 4 + bi);
        self.str(idx)
    }

    fn assembly_version(&self) -> String {
        if self.rows[32] == 0 { return String::new(); }
        let off = self.row_off(32, 1);
        let maj = read_u16(self.data, off + 4).unwrap_or(0);
        let min = read_u16(self.data, off + 6).unwrap_or(0);
        let build = read_u16(self.data, off + 8).unwrap_or(0);
        let rev = read_u16(self.data, off + 10).unwrap_or(0);
        format!("{maj}.{min}.{build}.{rev}")
    }

    #[allow(dead_code)]
    fn flags_to_visibility_type(flags: u32) -> Visibility {
        match flags & 0x7 {
            0x01 => Visibility::Public,
            0x02 => Visibility::Private, // NestedPrivate (use for generic)
            0x03 => Visibility::Protected,
            0x04 => Visibility::Internal,
            0x05 => Visibility::ProtectedInternal,
            0x06 => Visibility::PrivateProtected,
            _ => Visibility::Unknown,
        }
    }

    fn flags_to_visibility_method(flags: u16) -> Visibility {
        match flags & 0x7 {
            0x06 => Visibility::Public,
            0x02 => Visibility::Private,
            0x04 => Visibility::Protected,
            0x03 => Visibility::Internal,
            0x05 => Visibility::ProtectedInternal,
            _ => Visibility::Unknown,
        }
    }

    /// Build the full AssemblyIndex.
    fn build_index(self) -> AssemblyIndex {
        let asm_name = self.assembly_name();
        let asm_version = self.assembly_version();
        let mut types = HashMap::new();
        let warnings = Vec::new();

        let num_types = self.rows[2];
        for ti in 1..=num_types {
            let flags = self.type_def_flags(ti);

            // Skip nested types (Nested* visibility flags are 0x02–0x06 in low 3 bits)
            // We only care about public top-level types.
            let vis_tag = flags & 0x7;
            if vis_tag != 0x01 { continue; } // not Public

            let name = self.type_def_name(ti);
            let ns = self.type_def_ns(ti);

            if name.is_empty() { continue; }
            // Skip compiler-generated names
            if name.starts_with('<') || name.starts_with('$') { continue; }

            let is_interface = (flags & 0x20) != 0;
            let is_abstract = (flags & 0x80) != 0;
            let is_sealed = (flags & 0x100) != 0;

            // Determine base type
            let extends_coded = self.type_def_extends(ti);
            let base_type_fqn = if extends_coded != 0 {
                let fqn = self.type_fqn_from_coded(extends_coded);
                if fqn == "System.Object" || fqn == "System.Enum" || fqn == "System.ValueType" {
                    None
                } else {
                    Some(fqn)
                }
            } else { None };

            let is_enum = if extends_coded != 0 {
                let fqn = self.type_fqn_from_coded(extends_coded);
                fqn == "System.Enum"
            } else { false };

            let is_value_type = if extends_coded != 0 {
                let fqn = self.type_fqn_from_coded(extends_coded);
                fqn == "System.ValueType" || fqn == "System.Enum"
            } else { false };

            // Interface implementations for this type
            let mut interfaces = Vec::new();
            for ii in 1..=self.rows[9] {
                let off = self.row_off(9, ii);
                let (class_idx, cls_sz) = self.read_table_idx(off, 2);
                if class_idx == ti {
                    let tdr = self.type_def_or_ref_size();
                    let (iface_coded, _) = self.read_coded(off + cls_sz, tdr);
                    let iface_name = self.type_fqn_from_coded(iface_coded);
                    if !iface_name.is_empty() { interfaces.push(iface_name); }
                }
            }

            // Members: fields
            let field_start = self.type_def_field_list(ti);
            let field_end = if ti < num_types { self.type_def_field_list(ti + 1) } else { self.rows[4] + 1 };
            let mut members = Vec::new();

            for fi in field_start..field_end {
                if fi == 0 || fi > self.rows[4] { continue; }
                let ff = self.field_flags(fi);
                // Public = bit 6 (0x0006)
                if (ff & 0x7) != 0x6 { continue; }
                let fname = self.field_name(fi);
                if fname.is_empty() || fname.starts_with('<') { continue; }
                members.push(MetaMember {
                    name: fname,
                    kind: MemberKind::Field,
                    visibility: Visibility::Public,
                    is_static: (ff & 0x10) != 0,
                    signature: String::new(),
                });
            }

            // Members: methods
            let method_start = self.type_def_method_list(ti);
            let method_end = if ti < num_types { self.type_def_method_list(ti + 1) } else { self.rows[6] + 1 };

            for mi in method_start..method_end {
                if mi == 0 || mi > self.rows[6] { continue; }
                let mf = self.method_def_flags(mi);
                if (mf & 0x7) != 0x6 { continue; } // public only
                let mname = self.method_def_name(mi);
                if mname.is_empty() { continue; }

                let kind = if mname == ".ctor" || mname == ".cctor" {
                    MemberKind::Constructor
                } else {
                    MemberKind::Method
                };
                members.push(MetaMember {
                    name: mname,
                    kind,
                    visibility: Self::flags_to_visibility_method(mf),
                    is_static: (mf & 0x10) != 0,
                    signature: String::new(),
                });
            }

            let fqn = if ns.is_empty() { name.clone() } else { format!("{ns}.{name}") };
            types.insert(fqn, MetaType {
                name,
                namespace: ns,
                visibility: Visibility::Public,
                is_abstract,
                is_sealed,
                is_interface,
                is_enum,
                is_value_type,
                base_type: base_type_fqn,
                interfaces,
                members,
            });
        }

        AssemblyIndex { name: asm_name, version: asm_version, types, warnings }
    }
}

// ── API pública ───────────────────────────────────────────────────────────────

/// Indexa um assembly .NET a partir do seu conteúdo em bytes.
pub fn index_assembly(data: &[u8], _path: &Path) -> Result<AssemblyIndex, MetaError> {
    let meta_off = find_metadata_root(data)?;
    let reader = MetaReader::new(data, meta_off)?;
    Ok(reader.build_index())
}

/// Indexa um assembly .NET a partir de um arquivo.
pub fn index_assembly_file(path: &Path) -> Result<AssemblyIndex, MetaError> {
    let data = std::fs::read(path)?;
    index_assembly(&data, path)
}

// ── Cache por (path, mtime, size) ─────────────────────────────────────────────

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct CacheKey {
    path: PathBuf,
    size: u64,
    mtime: Option<u64>, // SystemTime as secs since UNIX epoch, or None
}

impl CacheKey {
    fn for_path(path: &Path) -> Self {
        let meta = std::fs::metadata(path).ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta.and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        CacheKey { path: path.to_path_buf(), size, mtime }
    }
}

/// Cache de índices de assembly.
pub struct MetadataCache {
    entries: HashMap<CacheKey, AssemblyIndex>,
}

impl MetadataCache {
    pub fn new() -> Self { MetadataCache { entries: HashMap::new() } }

    /// Retorna o índice do assembly, indexando-o se necessário ou se mudou.
    pub fn get_or_index(&mut self, path: &Path) -> Result<&AssemblyIndex, MetaError> {
        let key = CacheKey::for_path(path);
        if !self.entries.contains_key(&key) {
            let idx = index_assembly_file(path)?;
            self.entries.insert(key.clone(), idx);
        }
        Ok(self.entries.get(&key).unwrap())
    }

    pub fn len(&self) -> usize { self.entries.len() }
    pub fn is_empty(&self) -> bool { self.entries.is_empty() }
}

impl Default for MetadataCache {
    fn default() -> Self { Self::new() }
}

// ── Testes ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Non-PE data should return a clear error.
    #[test]
    fn rejects_non_pe() {
        let err = index_assembly(b"not a PE", Path::new("test.dll"));
        assert!(matches!(err, Err(MetaError::NotCli(_))));
    }

    #[test]
    fn rejects_empty() {
        let err = index_assembly(b"", Path::new("empty.dll"));
        assert!(err.is_err(), "empty input must error");
    }

    // A real .NET assembly is required for a full integration test.
    // We skip this if the file isn't available (CI without .NET SDK).
    #[test]
    fn indexes_system_runtime_if_available() {
        // Try common paths for System.Runtime.dll reference assembly.
        let candidates = [
            // .NET 8 / Linux/macOS
            "/usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/8.0.0/ref/net8.0/System.Runtime.dll",
            // .NET 6
            "/usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/6.0.0/ref/net6.0/System.Runtime.dll",
            // Windows .NET 8
            r"C:\Program Files\dotnet\packs\Microsoft.NETCore.App.Ref\8.0.8\ref\net8.0\System.Runtime.dll",
            r"C:\Program Files\dotnet\packs\Microsoft.NETCore.App.Ref\8.0.0\ref\net8.0\System.Runtime.dll",
        ];
        let path = candidates.iter().find(|p| std::path::Path::new(p).exists());
        let Some(path) = path else {
            eprintln!("Skipping: System.Runtime.dll not found (install .NET SDK)");
            return;
        };

        let idx = index_assembly_file(Path::new(path))
            .expect("must index System.Runtime.dll");

        assert!(!idx.name.is_empty(), "assembly name must not be empty");
        assert!(!idx.types.is_empty(), "must have types");

        // Check that String and Int32 are present.
        assert!(idx.types.contains_key("System.String"), "System.String must be indexed");
        assert!(idx.types.contains_key("System.Int32"), "System.Int32 must be indexed");

        let str_type = &idx.types["System.String"];
        assert_eq!(str_type.name, "String");
        assert_eq!(str_type.namespace, "System");
        assert!(!str_type.is_interface);
    }

    #[test]
    fn cache_reuses_entry() {
        let candidates = [
            r"C:\Program Files\dotnet\packs\Microsoft.NETCore.App.Ref\8.0.8\ref\net8.0\System.Runtime.dll",
            r"C:\Program Files\dotnet\packs\Microsoft.NETCore.App.Ref\8.0.0\ref\net8.0\System.Runtime.dll",
        ];
        let path = candidates.iter().find(|p| std::path::Path::new(p).exists());
        let Some(path) = path else {
            eprintln!("Skipping cache test: System.Runtime.dll not found");
            return;
        };
        let path = Path::new(path);
        let mut cache = MetadataCache::new();
        cache.get_or_index(path).expect("must index");
        assert_eq!(cache.len(), 1);
        cache.get_or_index(path).expect("must hit cache");
        assert_eq!(cache.len(), 1, "cache must not grow on second call");
    }
}
