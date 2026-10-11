import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesFor, detectPlatform, getPlatform, osFromUserAgent, setPlatformForTests } from "./os.ts";
import { platformLabels } from "./labels.ts";
import { formatKeybinding, formatShortcutsInText, keybindingFor } from "./keybinding.ts";
import { fontStacks } from "./fonts.ts";

test("detecção: o snapshot injetado pelo Rust vence o user agent", () => {
  const p = detectPlatform({
    injected: { os: "linux", arch: "aarch64", family: "unix", desktop: "GNOME", wayland: true, capabilities: { customCaptionButtons: true } },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  });
  assert.equal(p.os, "linux");
  assert.equal(p.arch, "aarch64");
  assert.equal(p.desktop, "GNOME");
  assert.equal(p.wayland, true);
  assert.equal(p.capabilities.snapLayouts, false);
});

test("detecção: injeção inválida cai para o user agent", () => {
  assert.equal(detectPlatform({ injected: { os: "beos" }, userAgent: "X11; Linux x86_64" }).os, "linux");
  assert.equal(detectPlatform({ injected: null, userAgent: "Macintosh; Intel Mac OS X" }).os, "macos");
  assert.equal(detectPlatform({}).os, "windows");
});

test("user agent por SO", () => {
  assert.equal(osFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "windows");
  assert.equal(osFromUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15"), "linux");
  assert.equal(osFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "macos");
  assert.equal(osFromUserAgent("Node.js/22"), "windows");
});

test("capacidades: macOS não desenha botões de janela; Snap só no Windows", () => {
  assert.equal(capabilitiesFor("macos").customCaptionButtons, false);
  assert.equal(capabilitiesFor("windows").customCaptionButtons, true);
  assert.equal(capabilitiesFor("linux").customCaptionButtons, true);
  assert.equal(capabilitiesFor("windows").snapLayouts, true);
  assert.equal(capabilitiesFor("linux").snapLayouts, false);
  assert.equal(capabilitiesFor("macos").pathsCaseInsensitive, true);
  assert.equal(capabilitiesFor("linux").pathsCaseInsensitive, false);
});

test("getPlatform é cacheado e substituível nos testes", () => {
  setPlatformForTests("macos");
  assert.equal(getPlatform().os, "macos");
  assert.equal(getPlatform(), getPlatform());
  setPlatformForTests(null);
  assert.equal(getPlatform().os, "windows"); // node: sem injeção, UA "Node.js"
});

test("rótulos de revelar por SO", () => {
  assert.equal(platformLabels("windows").revealInFileManager, "Revelar no Explorador de Arquivos");
  assert.equal(platformLabels("linux").revealInFileManager, "Revelar no Gerenciador de Arquivos");
  assert.equal(platformLabels("macos").revealInFileManager, "Revelar no Finder");
  assert.equal(platformLabels("macos").moveToTrash, "Mover para o Lixo");
  for (const os of ["windows", "linux", "macos"] as const) {
    assert.doesNotMatch(platformLabels(os).revealInFileManager, /Explorer do Windows/);
  }
});

test("atalhos: Ctrl/Alt/Shift no Windows e Linux", () => {
  for (const os of ["windows", "linux"] as const) {
    assert.equal(formatKeybinding("Ctrl+Shift+P", os), "Ctrl+Shift+P");
    assert.equal(formatKeybinding("shift+ctrl+p", os), "Ctrl+Shift+P");
    assert.equal(formatKeybinding("Ctrl+K Ctrl+O", os), "Ctrl+K Ctrl+O");
    assert.equal(formatKeybinding("alt+shift+f", os), "Shift+Alt+F");
    assert.equal(formatKeybinding("Ctrl+`", os), "Ctrl+`");
  }
  assert.equal(formatKeybinding("meta+e", "windows"), "Win+E");
  assert.equal(formatKeybinding("meta+e", "linux"), "Super+E");
});

test("atalhos: ⌘/⌥/⇧/⌃ no macOS, com Ctrl do app = CtrlCmd", () => {
  assert.equal(formatKeybinding("Ctrl+P", "macos"), "⌘P");
  assert.equal(formatKeybinding("Ctrl+Shift+P", "macos"), "⇧⌘P");
  assert.equal(formatKeybinding("Ctrl+K Ctrl+O", "macos"), "⌘K ⌘O");
  assert.equal(formatKeybinding("Alt+Shift+F", "macos"), "⌥⇧F");
  assert.equal(formatKeybinding("mod+s", "macos"), "⌘S");
  assert.equal(formatKeybinding("winctrl+`", "macos"), "⌃`");
  assert.equal(formatKeybinding("winctrl+tab", "linux"), "Ctrl+Tab");
  assert.equal(formatKeybinding("winctrl+alt+shift+cmd+x", "macos"), "⌃⌥⇧⌘X");
  // Formato VS Code das extensões: `ctrl` é o Control físico.
  assert.equal(formatKeybinding("ctrl+j", "macos", { ctrlIsCmd: false }), "⌃J");
  assert.equal(formatKeybinding("ctrl++", "macos"), "⌘+");
});

test("atalhos dentro de texto livre", () => {
  assert.equal(formatShortcutsInText("Mostrar barra lateral (Ctrl+B)", "macos"), "Mostrar barra lateral (⌘B)");
  assert.equal(formatShortcutsInText("Abra uma pasta (ou Ctrl+K Ctrl+O) para começar.", "macos"), "Abra uma pasta (ou ⌘K ⌘O) para começar.");
  assert.equal(formatShortcutsInText("Paleta (Ctrl+Shift+P)", "linux"), "Paleta (Ctrl+Shift+P)");
  assert.equal(formatShortcutsInText("sem atalho", "macos"), "sem atalho");
});

test("keybindingFor usa o campo mac/linux da contribuição", () => {
  const kbs = [{ command: "a", key: "ctrl+shift+a", mac: "cmd+shift+a", linux: "ctrl+alt+a" }, { command: "b", key: "ctrl+b" }];
  assert.equal(keybindingFor("a", kbs, "macos"), "⇧⌘A");
  assert.equal(keybindingFor("a", kbs, "linux"), "Ctrl+Alt+A");
  assert.equal(keybindingFor("a", kbs, "windows"), "Ctrl+Shift+A");
  assert.equal(keybindingFor("b", kbs, "macos"), "⌃B");
});

test("pilhas de fonte por SO", () => {
  assert.match(fontStacks("linux").ui, /^system-ui, Cantarell, "Noto Sans"/);
  assert.match(fontStacks("linux").mono, /"JetBrains Mono", "Fira Code".*"DejaVu Sans Mono", monospace$/);
  assert.match(fontStacks("macos").ui, /^-apple-system/);
  assert.match(fontStacks("macos").mono, /^"SF Mono"/);
  assert.match(fontStacks("windows").ui, /Segoe UI/);
  for (const os of ["windows", "linux", "macos"] as const) {
    assert.match(fontStacks(os).mono, /monospace$/);
    assert.match(fontStacks(os).ui, /sans-serif$/);
  }
});
