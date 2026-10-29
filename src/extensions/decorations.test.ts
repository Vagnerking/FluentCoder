import assert from "node:assert/strict";
import test from "node:test";
import { gutterIconSize, monacoDecorationOptions, renderDecorationInstance, renderDecorationType } from "./editorModel.ts";

const resolve = (id: string) => (id === "editorGutter.modifiedBackground" ? "#0078d4" : undefined);
const SVG = "data:image/svg+xml;base64,PHN2Zy8+";

test("decorações: ícone de gutter → glyph margin com background-size do gutterIconSize", () => {
  const r = renderDecorationType("g1", { gutterIconPath: { dataUri: SVG }, gutterIconSize: "75%" }, resolve);
  assert.equal(r.options.glyphMarginClassName, "extd-g1-gutter");
  assert.ok(r.css.includes(`.extd-g1-gutter{background:url("${SVG}") center center no-repeat;background-size:75%}`));
  // data: URI que não é imagem/base64 é recusado (defesa em profundidade).
  for (const bad of ["data:text/html;base64,PGI+", 'data:image/png;base64,AA")}body{x', "https://x/y.png", "/etc/passwd"]) {
    const x = renderDecorationType("g2", { gutterIconPath: { dataUri: bad } }, resolve);
    assert.equal(x.options.glyphMarginClassName, undefined, bad);
    assert.equal(x.css, "");
  }
  assert.equal(gutterIconSize(undefined), "contain");
  assert.equal(gutterIconSize("cover"), "cover");
  assert.equal(gutterIconSize("10px;x"), "contain");
});

test("decorações: régua (cor + lane), isWholeLine, rangeBehavior e anexos before/after", () => {
  const r = renderDecorationType(
    "d1",
    {
      isWholeLine: true,
      overviewRulerColor: { themeColor: "editorGutter.modifiedBackground" },
      overviewRulerLane: 4,
      rangeBehavior: 1,
      before: { contentIconPath: { dataUri: SVG }, width: "12px", height: "12px", margin: "0 4px 0 0" },
      after: { contentText: " — você, há 2 dias", color: "gray", fontStyle: "italic" },
    },
    resolve,
  );
  assert.equal(r.options.isWholeLine, true);
  assert.equal(r.options.className, undefined, "sem estilo próprio: só a linha inteira");
  assert.equal(r.options.stickiness, 1);
  assert.ok(r.css.includes(".extd-d1-before::before{margin:0 4px 0 0;content:\"\";display:inline-block;background:url("));
  assert.ok(r.css.includes("width:12px;height:12px"));
  assert.ok(r.css.includes('.extd-d1-after::after{color:gray;font-style:italic;content:" — você, há 2 dias"}'));
  const m = monacoDecorationOptions(r, null, "**hover**");
  assert.deepEqual(m.overviewRuler, { color: "#0078d4", position: 4 });
  assert.equal(m.overviewRulerColor, undefined, "não vaza chave desconhecida ao Monaco");
  assert.deepEqual(m.hoverMessage, { value: "**hover**" });
  assert.equal(m.beforeContentClassName, "extd-d1-before");
  // Lane inválida → Center (padrão do VS Code).
  assert.equal(renderDecorationType("d3", { overviewRulerColor: "red", overviewRulerLane: 9 }, resolve).options.overviewRulerLane, 2);
});

test("decorações: renderOptions por faixa viram classes próprias que sobrepõem as do tipo", () => {
  const type = renderDecorationType("b1", { after: { contentText: "tipo", color: "gray" } }, resolve);
  const inst = renderDecorationInstance("b1", { after: { contentText: "Ana, ontem" } }, resolve);
  assert.ok(inst);
  assert.match(inst!.options.afterContentClassName!, /^extd-b1-i[a-z0-9]+-after$/);
  assert.ok(inst!.css.includes('content:"Ana, ontem"'));
  // Mesmo conteúdo → mesma classe (CSS registrado uma vez).
  assert.equal(renderDecorationInstance("b1", { after: { contentText: "Ana, ontem" } }, resolve)!.options.afterContentClassName, inst!.options.afterContentClassName);
  const m = monacoDecorationOptions(type, inst);
  assert.equal(m.afterContentClassName, inst!.options.afterContentClassName);
  assert.equal(renderDecorationInstance("b1", undefined, resolve), null);
  assert.equal(renderDecorationInstance("b1", { after: { color: "x;}" } }, resolve), null);
});
