/**
 * EditorConfig (https://spec.editorconfig.org) aplicado ao editor, como a
 * extensão EditorConfig do VS Code: as propriedades do `.editorconfig` mais
 * específico VENCEM as settings (inclusive as de linguagem).
 *
 * Puro: o Rust devolve a cadeia de arquivos (`editorconfig_chain`, raiz →
 * pasta do arquivo, parando em `root = true`); aqui ficam o parse INI, o glob
 * da spec e a resolução.
 */

export interface EditorConfigFile {
  /** Pasta do `.editorconfig`. */
  dir: string;
  content: string;
}

export type EditorConfigProps = Record<string, string>;

interface Section {
  glob: string;
  props: EditorConfigProps;
}

/** Parse INI da spec: `[glob]`, `chave = valor`, comentários `#`/`;`. */
export function parseEditorConfig(content: string): { root: boolean; sections: Section[] } {
  let root = false;
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) {
      current = { glob: sec[1], props: {} };
      sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    // Comentário no fim da linha (`;`/`#` depois de espaço) não faz parte do valor.
    let value = line.slice(eq + 1).trim().replace(/\s+[#;].*$/, "");
    if (key.length > 50 || value.length > 255) continue;
    // Valores das propriedades da spec não diferenciam maiúsculas.
    if (/^(true|false|unset|lf|crlf|cr|space|tab|utf-8|utf-8-bom|latin1|utf-16le|utf-16be)$/i.test(value)) {
      value = value.toLowerCase();
    }
    if (!current) {
      if (key === "root") root = value.toLowerCase() === "true";
      continue;
    }
    current.props[key] = value;
  }
  return { root, sections };
}

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|\\]/g, "\\$&");
}

/**
 * Glob da spec → RegExp + checagens de faixa numérica (`{1..3}`).
 * `*` não cruza `/`, `**` cruza, `?` um caractere, `[abc]`/`[!abc]`,
 * `{a,b}` alternativas, `{n1..n2}` inteiros.
 */
export function compileGlob(glob: string): (relPath: string) => boolean {
  const ranges: [number, number][] = [];
  let re = "";
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) {
      re += escapeRe(glob[i + 1]);
      i += 2;
      continue;
    }
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
      } else {
        re += "[^/]*";
        i++;
      }
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) {
        let cls = glob.slice(i + 1, end);
        if (cls.includes("/")) {
          re += "\\[";
          i++;
          continue;
        }
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        re += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = end + 1;
        continue;
      }
      re += "\\[";
      i++;
      continue;
    }
    if (c === "{") {
      const end = glob.indexOf("}", i + 1);
      const inner = end > i ? glob.slice(i + 1, end) : "";
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(inner);
      if (range) {
        ranges.push([Number(range[1]), Number(range[2])]);
        re += "(-?\\d+)";
        i = end + 1;
        continue;
      }
      if (end > i && inner.includes(",")) {
        re += "(?:";
        braceDepth++;
        i++;
        continue;
      }
      re += "\\{";
      i++;
      continue;
    }
    if (c === "," && braceDepth > 0) {
      re += "|";
      i++;
      continue;
    }
    if (c === "}" && braceDepth > 0) {
      re += ")";
      braceDepth--;
      i++;
      continue;
    }
    re += escapeRe(c);
    i++;
  }
  while (braceDepth-- > 0) re += ")";
  const rx = new RegExp(`^${re}$`);
  return (relPath: string) => {
    const m = rx.exec(relPath);
    if (!m) return false;
    if (!ranges.length) return true;
    // Os grupos de faixa são os capturantes (as alternativas usam `(?:`).
    const nums = m.slice(1);
    return ranges.every(([a, b], idx) => {
      const n = Number(nums[idx]);
      return n >= Math.min(a, b) && n <= Math.max(a, b);
    });
  };
}

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** A seção casa com o arquivo? (`glob` sem `/` vale em qualquer nível.) */
export function sectionMatches(glob: string, configDir: string, filePath: string): boolean {
  const dir = norm(configDir).replace(/\/+$/, "");
  const file = norm(filePath);
  if (!file.startsWith(dir + "/")) return false;
  const rel = file.slice(dir.length + 1);
  let pattern = glob;
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  else if (!pattern.includes("/")) pattern = "**/" + pattern;
  return compileGlob(pattern)(rel) || (pattern.startsWith("**/") && compileGlob(pattern.slice(3))(rel));
}

/** Propriedades efetivas para `filePath` (o último arquivo/seção vence; `unset` remove). */
export function resolveEditorConfig(chain: readonly EditorConfigFile[], filePath: string): EditorConfigProps {
  const out: EditorConfigProps = {};
  for (const file of chain) {
    const parsed = parseEditorConfig(file.content);
    for (const section of parsed.sections) {
      if (!sectionMatches(section.glob, file.dir, filePath)) continue;
      for (const [k, v] of Object.entries(section.props)) {
        if (v.toLowerCase() === "unset") delete out[k];
        else out[k] = v;
      }
    }
  }
  // Regras de derivação da spec.
  if (out.indent_style === "tab" && !out.indent_size) out.indent_size = "tab";
  if (out.indent_size && out.indent_size !== "tab" && !out.tab_width) out.tab_width = out.indent_size;
  if (out.indent_size === "tab" && out.tab_width) out.indent_size = out.tab_width;
  return out;
}

/** O que o editor/salvamento faz com as propriedades (só as presentes). */
export interface EditorConfigOverrides {
  insertSpaces?: boolean;
  tabSize?: number;
  indentSize?: number;
  eol?: "\n" | "\r\n";
  /** Encoding no formato do app (`UTF-8`, `UTF-16LE`…) + BOM. */
  encoding?: { id: string; bom: boolean };
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  /** `max_line_length` vira régua. */
  ruler?: number;
}

const CHARSETS: Record<string, { id: string; bom: boolean }> = {
  "utf-8": { id: "UTF-8", bom: false },
  "utf-8-bom": { id: "UTF-8", bom: true },
  latin1: { id: "windows-1252", bom: false },
  "utf-16le": { id: "UTF-16LE", bom: true },
  "utf-16be": { id: "UTF-16BE", bom: true },
};

export function editorConfigOverrides(props: EditorConfigProps): EditorConfigOverrides {
  const o: EditorConfigOverrides = {};
  if (props.indent_style === "space") o.insertSpaces = true;
  else if (props.indent_style === "tab") o.insertSpaces = false;
  const tab = Number(props.tab_width);
  if (Number.isInteger(tab) && tab > 0 && tab <= 32) o.tabSize = tab;
  const indent = Number(props.indent_size);
  if (Number.isInteger(indent) && indent > 0 && indent <= 32) {
    o.indentSize = indent;
    if (o.tabSize === undefined) o.tabSize = indent;
  }
  if (props.end_of_line === "lf") o.eol = "\n";
  else if (props.end_of_line === "crlf") o.eol = "\r\n";
  if (props.charset && CHARSETS[props.charset]) o.encoding = CHARSETS[props.charset];
  if (props.trim_trailing_whitespace === "true") o.trimTrailingWhitespace = true;
  else if (props.trim_trailing_whitespace === "false") o.trimTrailingWhitespace = false;
  if (props.insert_final_newline === "true") o.insertFinalNewline = true;
  else if (props.insert_final_newline === "false") o.insertFinalNewline = false;
  const max = Number(props.max_line_length);
  if (Number.isInteger(max) && max > 0) o.ruler = max;
  return o;
}
