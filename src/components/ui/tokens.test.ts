import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Fase 1 da padronização de UI: os primitivos de `src/components/ui` dependem
// destes tokens. Os testes travam o contrato do `:root` e as variáveis que antes
// eram usadas sem nunca serem definidas (renderizavam só pelo fallback inline).

/**
 * Folha global na ordem da cascata: os `import "./styles…css"` de src/main.tsx,
 * resolvendo os `@import` de cada arquivo (src/styles/*.css).
 */
function readGlobalStylesheet(): string {
  const srcDir = new URL("../../", import.meta.url);
  const read = (url: URL): string => {
    const text = readFileSync(url, "utf8");
    return text.replace(/^@import '([^']+)';\s*$/gm, (_m, rel: string) => read(new URL(rel, url)));
  };
  const mainTsx = readFileSync(new URL("main.tsx", srcDir), "utf8");
  return [...mainTsx.matchAll(/^import "\.\/(styles[^"]*\.css)";$/gm)]
    .map((m) => read(new URL(m[1], srcDir)))
    .join("\n");
}

const css = readGlobalStylesheet();
const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

/** Value declared for `name` inside `:root`, or null. */
function token(name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*:\\s*([^;]+);`).exec(root);
  return m ? m[1].trim() : null;
}

test("escala de espaçamento Fluent 2 (base 4px)", () => {
  assert.equal(token("--space-xxs"), "2px");
  assert.equal(token("--space-xs"), "4px");
  assert.equal(token("--space-sm"), "8px");
  assert.equal(token("--space-md"), "16px");
  assert.equal(token("--space-lg"), "24px");
  assert.equal(token("--space-xl"), "32px");
});

test("type ramp, alturas de controle, ícones e estado desabilitado", () => {
  assert.equal(token("--font-caption"), "12px");
  assert.equal(token("--line-height-caption"), "16px");
  assert.equal(token("--font-body"), "14px");
  assert.equal(token("--line-height-body"), "20px");
  assert.equal(token("--font-subtitle"), "16px");
  assert.equal(token("--line-height-subtitle"), "22px");
  assert.equal(token("--control-h-sm"), "24px");
  assert.equal(token("--control-h-md"), "32px");
  assert.equal(token("--control-h-lg"), "36px");
  assert.equal(token("--icon-sm"), "14px");
  assert.equal(token("--icon-md"), "16px");
  assert.equal(token("--opacity-disabled"), "0.4");
  assert.ok(token("--font-mono"), "--font-mono definido");
  for (const name of ["--accent-hover", "--accent-pressed", "--text-on-accent", "--color-surface-raised"]) {
    assert.ok(token(name), `${name} definido`);
  }
});

test("variáveis antes indefinidas agora resolvem para tokens reais", () => {
  for (const name of ["--bg-elevated", "--font-mono", "--fill-subtle", "--acrylic-bg", "--danger", "--mono-font"]) {
    assert.ok(token(name), `${name} precisa estar definido no :root`);
  }
});

test("o font-size global do body continua 13px", () => {
  const body = /\nbody\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(body, /font-size:\s*13px/);
});

test("o CSS do ConfirmDialog existe uma vez só (bloco duplicado removido)", () => {
  assert.equal(css.match(/^\.confirm-dialog\s*\{/gm)?.length, 1);
  assert.equal(css.match(/^\.confirm-overlay\s*\{/gm)?.length, 1);
});

test("a altura da opção do Select no CSS bate com OPTION_HEIGHT do componente", () => {
  const tsx = readFileSync(new URL("./Select.tsx", import.meta.url), "utf8");
  const optionHeight = Number(/const OPTION_HEIGHT = (\d+)/.exec(tsx)?.[1]);
  const rule = /\.ui-select-option\s*\{[^}]*min-height:\s*(\d+)px/.exec(css);
  const gap = /\.ui-select-popup\s*\{[^}]*gap:\s*(\d+)px/.exec(css);
  assert.ok(rule && gap, "regras .ui-select-option/.ui-select-popup presentes");
  assert.equal(Number(rule[1]) + Number(gap[1]), optionHeight);
});
