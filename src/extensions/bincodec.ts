/**
 * Binário nas mensagens de webview — espelho de `tools/ext-host/src/bincodec.js`
 * (os dois precisam concordar no formato `{ __fluentBin: <tipo>, b64 }`).
 *
 * O VS Code entrega extensão ↔ webview por structured clone, que preserva
 * `Uint8Array`/`ArrayBuffer`; o nosso caminho passa por JSON (Node → Rust →
 * app). O app decodifica o que vem do host antes do `postMessage` ao iframe
 * (que preserva binário) e codifica o que o iframe manda antes de ir ao host.
 */

const TAG = "__fluentBin";

type ViewCtor = { new (buffer: ArrayBuffer): ArrayBufferView };
const VIEWS: Record<string, ViewCtor> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // evita estourar a pilha do apply em buffers grandes
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mapShallow(value: unknown, fn: (v: unknown) => unknown): unknown {
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const v = fn(value[i]);
      if (v !== value[i]) {
        out = out ?? value.slice();
        out[i] = v;
      }
    }
    return out ?? value;
  }
  const obj = value as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(obj)) {
    const v = fn(obj[key]);
    if (v !== obj[key]) {
      out = out ?? { ...obj };
      out[key] = v;
    }
  }
  return out ?? value;
}

export function encodeBinary(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof ArrayBuffer) return { [TAG]: "ArrayBuffer", b64: toBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const kind = value.constructor.name;
    if (!VIEWS[kind]) return value;
    return { [TAG]: kind, b64: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (!Array.isArray(value) && typeof (value as { toJSON?: unknown }).toJSON === "function") return value;
  return mapShallow(value, encodeBinary);
}

export function decodeBinary(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const kind = obj[TAG];
    if (typeof kind === "string" && typeof obj.b64 === "string") {
      const bytes = fromBase64(obj.b64);
      if (kind === "ArrayBuffer") return bytes.buffer;
      const View = VIEWS[kind];
      if (!View) return value;
      return kind === "Uint8Array" ? bytes : new View(bytes.buffer as ArrayBuffer);
    }
  }
  return mapShallow(value, decodeBinary);
}
