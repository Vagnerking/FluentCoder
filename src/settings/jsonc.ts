/**
 * JSONC (JSON com comentários e vírgula final) — parse tolerante e edição
 * pontual que PRESERVA comentários e formatação, no espírito do `jsonc-parser`
 * do VS Code (`modify`/`applyEdits`). Puro: sem DOM nem Tauri, testável com
 * `node --test`.
 *
 * - `parseJsonc(text)` → `{ value, errors }` (comentários e vírgula final
 *   aceitos; erros não impedem o melhor valor possível).
 * - `parseTree(text)` → árvore com offsets (base da edição).
 * - `setJsoncValue(text, path, value)` → texto novo com a propriedade criada,
 *   trocada ou removida (`value === undefined`) — o resto do arquivo intacto.
 */

export interface JsoncError {
  message: string;
  offset: number;
}

export type JsonNodeType = "object" | "array" | "property" | "string" | "number" | "boolean" | "null";

export interface JsonNode {
  type: JsonNodeType;
  offset: number;
  length: number;
  value?: unknown;
  children?: JsonNode[];
  /** Propriedade: nó da chave (string) e do valor. */
  key?: JsonNode;
  valueNode?: JsonNode;
  /** Offset da vírgula que segue este nó dentro do pai (se houver). */
  commaOffset?: number;
}

type Tok =
  | { kind: "{" | "}" | "[" | "]" | ":" | ","; offset: number; length: number }
  | { kind: "string"; offset: number; length: number; value: string }
  | { kind: "number"; offset: number; length: number; value: number }
  | { kind: "literal"; offset: number; length: number; value: boolean | null }
  | { kind: "eof"; offset: number; length: 0 }
  | { kind: "bad"; offset: number; length: number };

class Scanner {
  pos = 0;
  readonly text: string;
  readonly errors: JsoncError[];
  constructor(text: string, errors: JsoncError[]) {
    this.text = text;
    this.errors = errors;
  }

  private skipTrivia(): void {
    const t = this.text;
    for (;;) {
      const c = t.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) {
        this.pos++;
      } else if (c === 47 /* / */ && t.charCodeAt(this.pos + 1) === 47) {
        while (this.pos < t.length && t[this.pos] !== "\n") this.pos++;
      } else if (c === 47 && t.charCodeAt(this.pos + 1) === 42 /* * */) {
        const end = t.indexOf("*/", this.pos + 2);
        if (end < 0) {
          this.errors.push({ message: "Comentário de bloco sem fechamento", offset: this.pos });
          this.pos = t.length;
        } else this.pos = end + 2;
      } else return;
    }
  }

  next(): Tok {
    this.skipTrivia();
    const t = this.text;
    const start = this.pos;
    if (start >= t.length) return { kind: "eof", offset: start, length: 0 };
    const ch = t[start];
    if ("{}[]:,".includes(ch)) {
      this.pos++;
      return { kind: ch as "{", offset: start, length: 1 };
    }
    if (ch === '"') {
      let i = start + 1;
      let out = "";
      while (i < t.length && t[i] !== '"') {
        if (t[i] === "\n") break;
        if (t[i] === "\\") {
          const e = t[i + 1];
          const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (e === "u") {
            out += String.fromCharCode(parseInt(t.slice(i + 2, i + 6), 16) || 0);
            i += 6;
            continue;
          }
          out += map[e] ?? e ?? "";
          i += 2;
          continue;
        }
        out += t[i++];
      }
      if (t[i] !== '"') this.errors.push({ message: "String sem fechamento", offset: start });
      else i++;
      this.pos = i;
      return { kind: "string", offset: start, length: i - start, value: out };
    }
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(t.slice(start, start + 64));
    if (num) {
      this.pos += num[0].length;
      return { kind: "number", offset: start, length: num[0].length, value: Number(num[0]) };
    }
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (t.startsWith(word, start)) {
        this.pos += word.length;
        return { kind: "literal", offset: start, length: word.length, value };
      }
    }
    // Token inválido: consome até um separador.
    let i = start + 1;
    while (i < t.length && !/[\s{}[\]:,"]/.test(t[i])) i++;
    this.pos = i;
    this.errors.push({ message: `Token inesperado "${t.slice(start, i)}"`, offset: start });
    return { kind: "bad", offset: start, length: i - start };
  }
}

/** Árvore com offsets. Tolerante: devolve o que conseguiu montar + erros. */
export function parseTree(text: string): { root: JsonNode | undefined; errors: JsoncError[] } {
  const errors: JsoncError[] = [];
  const sc = new Scanner(text, errors);
  let tok: Tok = sc.next();
  // Função (não a variável) para o TS não estreitar o tipo entre avanços.
  const cur = (): Tok => tok;
  const advance = () => (tok = sc.next());

  function parseValue(): JsonNode | undefined {
    const t = cur();
    switch (t.kind) {
      case "{":
        return parseObject();
      case "[":
        return parseArray();
      case "string": {
        const n: JsonNode = { type: "string", offset: t.offset, length: t.length, value: t.value };
        advance();
        return n;
      }
      case "number": {
        const n: JsonNode = { type: "number", offset: t.offset, length: t.length, value: t.value };
        advance();
        return n;
      }
      case "literal": {
        const n: JsonNode = {
          type: t.value === null ? "null" : "boolean",
          offset: t.offset,
          length: t.length,
          value: t.value,
        };
        advance();
        return n;
      }
      default:
        errors.push({ message: "Valor esperado", offset: t.offset });
        if (t.kind !== "eof" && t.kind !== "}" && t.kind !== "]") advance();
        return undefined;
    }
  }

  function parseObject(): JsonNode {
    const node: JsonNode = { type: "object", offset: cur().offset, length: 0, children: [] };
    advance(); // {
    while (cur().kind !== "}" && cur().kind !== "eof") {
      const kt = cur();
      if (kt.kind !== "string") {
        errors.push({ message: "Nome de propriedade esperado", offset: kt.offset });
        advance();
        continue;
      }
      const key: JsonNode = { type: "string", offset: kt.offset, length: kt.length, value: kt.value };
      const prop: JsonNode = { type: "property", offset: kt.offset, length: kt.length, key };
      advance();
      if (cur().kind === ":") advance();
      else errors.push({ message: "':' esperado", offset: cur().offset });
      const value = parseValue();
      if (value) {
        prop.valueNode = value;
        prop.length = value.offset + value.length - prop.offset;
      }
      node.children!.push(prop);
      if (cur().kind === ",") {
        prop.commaOffset = cur().offset;
        advance();
      } else if (cur().kind !== "}") {
        errors.push({ message: "',' esperada", offset: cur().offset });
        if (cur().kind !== "string") break;
      }
    }
    if (cur().kind === "}") {
      node.length = cur().offset + 1 - node.offset;
      advance();
    } else {
      errors.push({ message: "'}' esperado", offset: cur().offset });
      node.length = cur().offset - node.offset;
    }
    node.value = undefined;
    return node;
  }

  function parseArray(): JsonNode {
    const node: JsonNode = { type: "array", offset: cur().offset, length: 0, children: [] };
    advance();
    while (cur().kind !== "]" && cur().kind !== "eof") {
      const v = parseValue();
      if (v) node.children!.push(v);
      if (cur().kind === ",") {
        if (v) v.commaOffset = cur().offset;
        advance();
      } else if (cur().kind !== "]") {
        errors.push({ message: "',' esperada", offset: cur().offset });
        break;
      }
    }
    if (cur().kind === "]") {
      node.length = cur().offset + 1 - node.offset;
      advance();
    } else {
      errors.push({ message: "']' esperado", offset: cur().offset });
      node.length = cur().offset - node.offset;
    }
    return node;
  }

  if (cur().kind === "eof") return { root: undefined, errors };
  const root = parseValue();
  if (cur().kind !== "eof") errors.push({ message: "Conteúdo após o fim do JSON", offset: cur().offset });
  return { root, errors };
}

/** Valor JS de um nó. */
export function nodeValue(node: JsonNode | undefined): unknown {
  if (!node) return undefined;
  switch (node.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const p of node.children ?? []) {
        if (p.valueNode) out[String(p.key!.value)] = nodeValue(p.valueNode);
      }
      return out;
    }
    case "array":
      return (node.children ?? []).map(nodeValue);
    case "property":
      return nodeValue(node.valueNode);
    default:
      return node.value;
  }
}

/** Parse tolerante: o melhor valor possível + erros (texto vazio → `{}`? não: undefined). */
export function parseJsonc(text: string): { value: unknown; errors: JsoncError[] } {
  const { root, errors } = parseTree(text);
  return { value: nodeValue(root), errors };
}

/** Lê um objeto JSONC; qualquer outra coisa (ou texto vazio) vira `{}`. */
export function parseJsoncObject(text: string | null | undefined): Record<string, unknown> {
  if (!text || !text.trim()) return {};
  const v = parseJsonc(text).value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface JsoncFormat {
  /** Unidade de indentação (ex.: "  ", "\t"). Detectada do arquivo quando omitida. */
  indent?: string;
  eol?: string;
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Indentação da linha que contém `offset`. */
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart));
  return m ? m[0] : "";
}

function detectIndent(text: string, root: JsonNode | undefined): string {
  const first = root?.children?.[0];
  if (first && root) {
    const inner = lineIndent(text, first.offset);
    const outer = lineIndent(text, root.offset);
    if (inner.length > outer.length && text.lastIndexOf("\n", first.offset) > root.offset) {
      return inner.slice(outer.length);
    }
  }
  return "  ";
}

function stringify(value: unknown, indent: string, base: string, eol: string): string {
  const raw = JSON.stringify(value, null, indent);
  return raw.split("\n").join(eol + base);
}

/** Aplica uma troca de faixa. */
function splice(text: string, offset: number, length: number, insert: string): string {
  return text.slice(0, offset) + insert + text.slice(offset + length);
}

/**
 * Cria/troca/remove a propriedade em `path` (só segmentos de objeto), preservando
 * comentários e o resto da formatação. Objetos intermediários ausentes são
 * criados. `value === undefined` remove (no-op se não existe).
 */
export function setJsoncValue(
  text: string,
  path: readonly string[],
  value: unknown,
  format: JsoncFormat = {},
): string {
  if (path.length === 0) throw new Error("caminho vazio");
  const eol = format.eol ?? detectEol(text);
  const { root } = parseTree(text);
  const indent = format.indent ?? detectIndent(text, root);

  if (!root || root.type !== "object") {
    if (value === undefined) return text;
    // Arquivo vazio/inválido na raiz: recria (mantém comentários iniciais se o texto só tinha trivia).
    let obj: unknown = value;
    for (let i = path.length - 1; i >= 0; i--) obj = { [path[i]]: obj };
    const body = stringify(obj, indent, "", eol);
    const trivia = root ? "" : text.trim() ? text.replace(/\s*$/, eol) : "";
    return trivia + body + eol;
  }

  let parent = root;
  for (let depth = 0; depth < path.length; depth++) {
    const seg = path[depth];
    const last = depth === path.length - 1;
    const props = parent.children ?? [];
    const idx = props.findIndex((p) => p.key?.value === seg);
    const prop = idx >= 0 ? props[idx] : undefined;

    if (prop && !last) {
      if (prop.valueNode?.type === "object") {
        parent = prop.valueNode;
        continue;
      }
      if (value === undefined) return text;
      // Existe mas não é objeto: troca pelo objeto aninhado.
      let obj: unknown = value;
      for (let i = path.length - 1; i > depth; i--) obj = { [path[i]]: obj };
      return replaceValue(text, prop, obj, indent, eol);
    }

    if (prop && last) {
      if (value === undefined) return removeProperty(text, parent, idx);
      return replaceValue(text, prop, value, indent, eol);
    }

    // Ausente.
    if (value === undefined) return text;
    let obj: unknown = value;
    for (let i = path.length - 1; i > depth; i--) obj = { [path[i]]: obj };
    return insertProperty(text, parent, seg, obj, indent, eol);
  }
  return text;
}

function replaceValue(text: string, prop: JsonNode, value: unknown, indent: string, eol: string): string {
  const v = prop.valueNode;
  const base = lineIndent(text, prop.offset);
  const rendered = stringify(value, indent, base, eol);
  if (!v) {
    // `"k":` sem valor: insere após os dois-pontos.
    const colon = text.indexOf(":", prop.key!.offset + prop.key!.length);
    return splice(text, colon + 1, 0, " " + rendered);
  }
  return splice(text, v.offset, v.length, rendered);
}

function insertProperty(
  text: string,
  obj: JsonNode,
  key: string,
  value: unknown,
  indent: string,
  eol: string,
): string {
  const props = obj.children ?? [];
  const closing = obj.offset + obj.length - 1; // posição do `}`
  const objIndent = lineIndent(text, obj.offset);
  if (props.length === 0) {
    const childIndent = objIndent + indent;
    const entry = `${JSON.stringify(key)}: ${stringify(value, indent, childIndent, eol)}`;
    // Mantém comentários que estejam dentro do objeto vazio.
    const inner = text.slice(obj.offset + 1, closing);
    if (inner.trim()) {
      const trimmed = inner.replace(/\s*$/, "");
      return text.slice(0, obj.offset + 1) + trimmed + eol + childIndent + entry + eol + objIndent + text.slice(closing);
    }
    return text.slice(0, obj.offset + 1) + eol + childIndent + entry + eol + objIndent + text.slice(closing);
  }
  const lastProp = props[props.length - 1];
  const childIndent = lineIndent(text, lastProp.offset);
  const entry = `${JSON.stringify(key)}: ${stringify(value, indent, childIndent, eol)}`;
  const lastEnd = lastProp.offset + lastProp.length;
  if (lastProp.commaOffset !== undefined) {
    // Vírgula final já existe: insere depois dela, mantendo a vírgula final.
    return splice(text, lastProp.commaOffset + 1, 0, eol + childIndent + entry + ",");
  }
  // Mesma linha que a última propriedade? (objeto inline `{ "a": 1 }`)
  const sameLine = !text.slice(lastProp.offset, closing).includes("\n");
  if (sameLine) return splice(text, lastEnd, 0, `, ${entry}`);
  return splice(text, lastEnd, 0, "," + eol + childIndent + entry);
}

function removeProperty(text: string, obj: JsonNode, idx: number): string {
  const props = obj.children ?? [];
  const prop = props[idx];
  const isLast = idx === props.length - 1;
  if (!isLast) {
    // Remove a propriedade + a vírgula + o resto da linha (se só espaço).
    let start = prop.offset;
    let end = (prop.commaOffset ?? prop.offset + prop.length) + 1;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const ownLine = /^[ \t]*$/.test(text.slice(lineStart, start));
    const rest = (ownLine ? /^[ \t]*(\r?\n)?/ : /^[ \t]*/).exec(text.slice(end));
    if (ownLine) start = lineStart;
    if (rest) end += rest[0].length;
    return splice(text, start, end - start, "");
  }
  const endOfProp = prop.commaOffset !== undefined ? prop.commaOffset + 1 : prop.offset + prop.length;
  if (idx > 0) {
    const prev = props[idx - 1];
    const prevEnd = prev.offset + prev.length;
    // Se havia vírgula final no último, preserva o estilo (mantém a do anterior).
    const keepComma = prop.commaOffset !== undefined;
    const from = keepComma ? (prev.commaOffset ?? prevEnd) + 1 : prevEnd;
    return splice(text, from, endOfProp - from, "");
  }
  // Única propriedade.
  let start = prop.offset;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, start))) start = lineStart - (text[lineStart - 2] === "\r" ? 2 : 1);
  if (start <= obj.offset) start = obj.offset + 1;
  return splice(text, start, endOfProp - start, "");
}
