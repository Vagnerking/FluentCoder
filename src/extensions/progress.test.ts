import assert from "node:assert/strict";
import test from "node:test";
import { clearProgress, endProgress, markCancelling, progressFromEvent, progressLabel, progressSnapshot, upsertProgress } from "./progress.ts";
import { applyProgressItem, clearStatusItems, statusItemsSnapshot } from "./statusBar.ts";

test("progresso: evento do host normalizado, cancelando preservado entre atualizações", () => {
  clearProgress();
  const p = progressFromEvent({ event: "progress", id: "p1", extensionId: "a.b", extensionName: "Codex", location: "notification", title: "Indexando", message: "x.ts", percent: 140, cancellable: true });
  assert.ok(p);
  assert.equal(p!.percent, 100, "limitado a 100");
  assert.equal(progressFromEvent({ id: "" }), null);
  assert.equal(progressFromEvent({ id: "z", location: "qualquer" })!.location, "window");
  upsertProgress(p!);
  markCancelling("p1");
  upsertProgress({ ...p!, message: "y.ts" });
  assert.equal(progressSnapshot()[0].cancelling, true);
  assert.equal(progressSnapshot()[0].message, "y.ts");
  endProgress("p1");
  assert.equal(progressSnapshot().length, 0);
  assert.equal(progressLabel({ title: "A", message: "b", extensionName: "X" }), "A: b");
  assert.equal(progressLabel({ title: "", message: "", extensionName: "X" }), "X");
});

test("progresso Window/SCM: item com spinner na barra; cancelável vira clicável", () => {
  clearStatusItems();
  applyProgressItem({ id: "p2", extensionId: "a.b", label: "Sincronizando", cancellable: true });
  const [item] = statusItemsSnapshot();
  assert.equal(item.text, "$(sync~spin) Sincronizando");
  assert.equal(item.cancelProgress, "p2");
  assert.match(item.tooltip!, /cancelar/);
  applyProgressItem({ id: "p3", extensionId: "a.b", label: "Outro", cancellable: false });
  assert.equal(statusItemsSnapshot().find((i) => i.id === "progress:p3")!.cancelProgress, undefined);
  applyProgressItem({ id: "p2", end: true });
  applyProgressItem({ id: "p3", end: true });
  assert.equal(statusItemsSnapshot().length, 0);
});
