'use strict';
// Binário nas mensagens de webview. O VS Code entrega as mensagens extensão ↔
// webview por structured clone, que preserva `Uint8Array`/`ArrayBuffer`; o
// nosso caminho passa por JSON (Node → Rust → app), onde um `Uint8Array` vira
// `{"0":123,"1":10,…}` — o RPC do Codex quebrava com "unknown special value:
// ["bytes",{…}]". Aqui o binário vira `{ __fluentBin: <tipo>, b64 }` antes do
// JSON e volta ao tipo original do outro lado (espelho em
// src/extensions/bincodec.ts — os dois precisam concordar no formato).

const TAG = '__fluentBin';
const VIEWS = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

function encodeBinary(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer) {
    return { [TAG]: 'ArrayBuffer', b64: Buffer.from(value).toString('base64') };
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // Buffer do Node é um Uint8Array: do outro lado chega como Uint8Array (como no VS Code).
    const kind = Buffer.isBuffer(value) ? 'Uint8Array' : value.constructor.name;
    if (!VIEWS[kind]) return value;
    return { [TAG]: kind, b64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const v = encodeBinary(value[i]);
      if (v !== value[i]) {
        out = out || value.slice();
        out[i] = v;
      }
    }
    return out || value;
  }
  if (typeof value.toJSON === 'function') return value; // Date, Uri… seguem o JSON normal
  let out = null;
  for (const key of Object.keys(value)) {
    const v = encodeBinary(value[key]);
    if (v !== value[key]) {
      out = out || { ...value };
      out[key] = v;
    }
  }
  return out || value;
}

function decodeBinary(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const v = decodeBinary(value[i]);
      if (v !== value[i]) {
        out = out || value.slice();
        out[i] = v;
      }
    }
    return out || value;
  }
  const kind = value[TAG];
  if (typeof kind === 'string' && typeof value.b64 === 'string') {
    const buf = Buffer.from(value.b64, 'base64');
    const bytes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (kind === 'ArrayBuffer') return bytes.buffer;
    const View = VIEWS[kind];
    if (!View) return value;
    return kind === 'Uint8Array' ? bytes : new View(bytes.buffer);
  }
  let out = null;
  for (const key of Object.keys(value)) {
    const v = decodeBinary(value[key]);
    if (v !== value[key]) {
      out = out || { ...value };
      out[key] = v;
    }
  }
  return out || value;
}

module.exports = { encodeBinary, decodeBinary, BIN_TAG: TAG };
