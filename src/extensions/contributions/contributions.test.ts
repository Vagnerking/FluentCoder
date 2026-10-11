import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonc, stripJsonc, ContributionParseError } from "./jsonc.ts";
import { parsePlist } from "./plist.ts";
import { normalizeInside, resolveFrom, extensionAssetUrl } from "./paths.ts";
import { contributionDecision, declarativePoints, codeRunnable, type ContributionCandidate } from "./policy.ts";

test("JSONC: comentários, vírgulas finais e strings com // preservadas", () => {
  const v = parseJsonc<Record<string, unknown>>(`{
    // comentário
    "url": "https://x.y/a", /* bloco */
    "list": [1, 2, 3,],
    "s": "a \\" // não é comentário",
  }`);
  assert.deepEqual(v, { url: "https://x.y/a", list: [1, 2, 3], s: 'a " // não é comentário' });
  assert.equal(stripJsonc('{"a":1,\n// x\n}'), '{"a":1\n\n}');
});

test("JSONC: tetos de tamanho e profundidade", () => {
  assert.throws(() => parseJsonc("{}", { maxChars: 1 }), ContributionParseError);
  const deep = "[".repeat(80) + "]".repeat(80);
  assert.throws(() => parseJsonc(deep), /aninhada/);
  assert.throws(() => parseJsonc("{a:1}"), /JSON inválido/);
});

test("plist: tmTheme com dict/array/strings e entidades", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>name</key><string>Monokai &amp; Co</string>
  <!-- comentário -->
  <key>settings</key>
  <array>
    <dict><key>settings</key><dict><key>background</key><string>#272822</string></dict></dict>
    <dict><key>scope</key><string>comment</string><key>settings</key><dict><key>foreground</key><string>#75715E</string><key>fontStyle</key><string/></dict></dict>
  </array>
  <key>n</key><integer>42</integer><key>ok</key><true/><key>r</key><real>1.5</real>
</dict></plist>`;
  const v = parsePlist(xml) as Record<string, unknown>;
  assert.equal(v.name, "Monokai & Co");
  assert.equal(v.n, 42);
  assert.equal(v.ok, true);
  assert.equal(v.r, 1.5);
  const settings = v.settings as Array<Record<string, unknown>>;
  assert.equal((settings[0].settings as Record<string, string>).background, "#272822");
  assert.equal(settings[1].scope, "comment");
  assert.equal((settings[1].settings as Record<string, string>).fontStyle, "");
});

test("plist: malformado lança", () => {
  assert.throws(() => parsePlist("<plist><dict><key>a</key>"), ContributionParseError);
  assert.throws(() => parsePlist("<plist><foo/></plist>"), ContributionParseError);
});

test("caminhos presos à raiz da extensão", () => {
  assert.equal(normalizeInside("./themes/dark.json"), "themes/dark.json");
  assert.equal(normalizeInside("a/./b/../c.json"), "a/c.json");
  assert.equal(normalizeInside("../outside.json"), null);
  assert.equal(normalizeInside("/etc/passwd"), null);
  assert.equal(normalizeInside("C:/x.json"), null);
  assert.equal(normalizeInside("a\\b.json"), null);
  assert.equal(normalizeInside("https://evil/x.svg"), null);
  assert.equal(resolveFrom("dist/material-icons.json", "./../icons/a.svg"), "icons/a.svg");
  assert.equal(resolveFrom("themes/a.json", "./base.json"), "themes/base.json");
  assert.equal(resolveFrom("a.json", "../../x.json"), null);
  assert.equal(extensionAssetUrl("pub.ext", "icons/a b.svg", false), "fcext://localhost/pub.ext/icons/a%20b.svg");
  assert.equal(extensionAssetUrl("pub.ext", "icons/a.svg", true), "http://fcext.localhost/pub.ext/icons/a.svg");
});

const cand = (patch: Partial<ContributionCandidate>): ContributionCandidate => ({
  id: "a.b",
  version: "1.0.0",
  enabled: true,
  gate: null,
  trust: null,
  manifest: { contributes: { themes: [{ label: "T", path: "t.json" }] } },
  ...patch,
});
const H = "1.108.2";

test("política: sem código aplica; desabilitada não; mista depende do portão e da setting", () => {
  assert.deepEqual(declarativePoints({ contributes: { themes: [{}], snippets: [], grammars: [{}] } }), ["themes", "grammars"]);
  assert.equal(contributionDecision(cand({}), { hostVersion: H, applyWhenCodeBlocked: false }).mode, "no-code");
  assert.equal(contributionDecision(cand({ enabled: false }), { hostVersion: H, applyWhenCodeBlocked: true }).apply, false);
  const mixed = cand({ manifest: { main: "a.js", contributes: { themes: [{}] } } });
  assert.equal(contributionDecision(mixed, { hostVersion: H, applyWhenCodeBlocked: true }).mode, "contributions-only");
  assert.equal(contributionDecision(mixed, { hostVersion: H, applyWhenCodeBlocked: false }).apply, false);
  const ok = { ...mixed, gate: { verdict: "partial", version: "1.0.0", hostVersion: H } };
  assert.equal(contributionDecision(ok, { hostVersion: H, applyWhenCodeBlocked: false }).mode, "with-code");
  // Portão de outra versão/shim não libera o código.
  assert.equal(codeRunnable({ ...ok, gate: { ...ok.gate, version: "0.9.0" } }, H), false);
  assert.equal(codeRunnable({ ...ok, gate: { ...ok.gate, hostVersion: "1.0.0" } }, H), false);
  // Não avaliada só com liberação explícita da mesma versão.
  const unknown = { ...mixed, gate: { verdict: "unknown", version: "1.0.0", hostVersion: H } };
  assert.equal(codeRunnable(unknown, H), false);
  assert.equal(codeRunnable({ ...unknown, trust: { version: "1.0.0", hostVersion: H } }, H), true);
  assert.equal(contributionDecision(cand({ manifest: { main: "a.js", contributes: { commands: [{}] } } }), { hostVersion: H, applyWhenCodeBlocked: true }).apply, false);
});
