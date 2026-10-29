/**
 * Leitor mínimo de property list XML (Apple plist) — o formato dos `.tmTheme`
 * e `.tmLanguage` que temas e gramáticas antigas ainda publicam.
 *
 * Só o subconjunto que o TextMate usa: `dict`, `array`, `key`, `string`,
 * `integer`, `real`, `true`, `false`, `date`, `data`. Sem DTD/entidades
 * externas (só as 5 predefinidas + numéricas), com teto de tamanho e de
 * profundidade. Puro (sem DOMParser, roda no `node:test`).
 */
import { ContributionParseError } from "./jsonc.ts";

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

interface Tok {
  kind: "open" | "close" | "empty" | "text";
  name: string;
  text: string;
}

function* tokens(xml: string): Generator<Tok> {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      yield { kind: "text", name: "", text: xml.slice(i) };
      return;
    }
    if (lt > i) yield { kind: "text", name: "", text: xml.slice(i, lt) };
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const raw = xml.slice(lt + 9, end === -1 ? n : end);
      // CDATA vira texto literal (sem decodificar entidades).
      yield { kind: "text", name: "#cdata", text: raw };
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt);
    if (gt === -1) throw new ContributionParseError("plist: tag não fechada");
    const inner = xml.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (inner.startsWith("/")) yield { kind: "close", name: inner.slice(1).trim(), text: "" };
    else if (inner.endsWith("/")) yield { kind: "empty", name: inner.slice(0, -1).trim().split(/\s/)[0], text: "" };
    else yield { kind: "open", name: inner.split(/\s/)[0], text: "" };
  }
}

/** Converte um plist XML em valor JS. Lança `ContributionParseError`. */
export function parsePlist(xml: string, maxChars = 4 * 1024 * 1024, maxDepth = 64): unknown {
  if (xml.length > maxChars) throw new ContributionParseError("plist grande demais");
  const it = tokens(xml);
  let peeked: Tok | undefined;
  const next = (): Tok | undefined => {
    if (peeked) {
      const t = peeked;
      peeked = undefined;
      return t;
    }
    const r = it.next();
    return r.done ? undefined : r.value;
  };
  const nextSignificant = (): Tok | undefined => {
    for (let t = next(); t; t = next()) {
      if (t.kind === "text" && t.name !== "#cdata" && !t.text.trim()) continue;
      return t;
    }
    return undefined;
  };
  const readText = (name: string): string => {
    let s = "";
    for (let t = next(); t; t = next()) {
      if (t.kind === "text") s += t.name === "#cdata" ? t.text : decode(t.text);
      else if (t.kind === "close" && t.name === name) return s;
      else throw new ContributionParseError(`plist: conteúdo inesperado em <${name}>`);
    }
    throw new ContributionParseError(`plist: <${name}> não fechado`);
  };
  const value = (tok: Tok, depth: number): unknown => {
    if (depth > maxDepth) throw new ContributionParseError("plist aninhado demais");
    if (tok.kind === "empty") {
      if (tok.name === "true") return true;
      if (tok.name === "false") return false;
      if (tok.name === "dict") return {};
      if (tok.name === "array") return [];
      if (tok.name === "string") return "";
      throw new ContributionParseError(`plist: <${tok.name}/> desconhecido`);
    }
    if (tok.kind !== "open") throw new ContributionParseError("plist: valor esperado");
    switch (tok.name) {
      case "dict": {
        const obj: Record<string, unknown> = {};
        for (;;) {
          const k = nextSignificant();
          if (!k) throw new ContributionParseError("plist: <dict> não fechado");
          if (k.kind === "close" && k.name === "dict") return obj;
          if (k.kind !== "open" || k.name !== "key") throw new ContributionParseError("plist: <key> esperado");
          const key = readText("key");
          const v = nextSignificant();
          if (!v) throw new ContributionParseError("plist: valor ausente");
          if (key !== "__proto__") obj[key] = value(v, depth + 1);
        }
      }
      case "array": {
        const arr: unknown[] = [];
        for (;;) {
          const v = nextSignificant();
          if (!v) throw new ContributionParseError("plist: <array> não fechado");
          if (v.kind === "close" && v.name === "array") return arr;
          arr.push(value(v, depth + 1));
        }
      }
      case "string":
      case "date":
      case "data":
        return readText(tok.name);
      case "integer":
        return parseInt(readText("integer"), 10);
      case "real":
        return parseFloat(readText("real"));
      case "plist": {
        const v = nextSignificant();
        return v ? value(v, depth + 1) : null;
      }
      default:
        throw new ContributionParseError(`plist: <${tok.name}> desconhecido`);
    }
  };
  const first = nextSignificant();
  if (!first) throw new ContributionParseError("plist vazio");
  return value(first, 0);
}
