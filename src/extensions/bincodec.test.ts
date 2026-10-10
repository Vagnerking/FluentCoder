import assert from "node:assert/strict";
import test from "node:test";
import { decodeBinary, encodeBinary } from "./bincodec.ts";

test("bincodec (app): ida e volta pelo JSON preserva os tipos binários", () => {
  const msg = { m: ["bytes", new Uint8Array([123, 10, 125])], ab: new Uint8Array([9]).buffer, i: new Int16Array([-2]) };
  const back = decodeBinary(JSON.parse(JSON.stringify(encodeBinary(msg)))) as typeof msg;
  assert.ok(back.m[1] instanceof Uint8Array);
  assert.deepEqual([...(back.m[1] as Uint8Array)], [123, 10, 125]);
  assert.ok(back.ab instanceof ArrayBuffer);
  assert.ok(back.i instanceof Int16Array);
  assert.equal(back.i[0], -2);
});

test("bincodec (app): formato compatível com o host Node", async () => {
  // O host usa Buffer → base64; o app precisa ler exatamente esse formato.
  const wire = { __fluentBin: "Uint8Array", b64: Buffer.from("ok").toString("base64") };
  const out = decodeBinary(wire) as Uint8Array;
  assert.equal(new TextDecoder().decode(out), "ok");
  const enc = encodeBinary(new TextEncoder().encode("ok")) as { __fluentBin: string; b64: string };
  assert.equal(Buffer.from(enc.b64, "base64").toString(), "ok");
});
