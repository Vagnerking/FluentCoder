import Editor, { BeforeMount, DiffEditor, OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { whenMonacoReady } from "../monaco-loader";
import type {
  BlameHunk,
  EditorActionsApi,
  FileDecoration,
  GitCommit,
  MatchSelection,
  OpenFile,
  Problem,
} from "../types";
import { languageForFile } from "../language";
import { gitBlame, gitDiffFile, gitLogFile, type GitRevisionDiffTarget } from "../api";
import { toFileUri, fromFileUri, canonicalFileUriKey } from "../lsp/uri";
import { setupMonacoForLsp } from "../lsp/monacoSetup";
import { debugSession } from "../dap/debugSession";
import {
  ensurePackageAuditCheck,
  ensurePackageInlineCheck,
  inlineAuditStateForPackageJson,
  inlineStateForPackageJson,
  packageIntelSnapshot,
  packageIntelSubscribe,
  packageVersionsForHover,
  setSelectedPackageManager,
  type PackageInlineState,
} from "../packages/packageIntelStore";
import type {
  PackageAuditSummary,
  PackageAuditVulnerability,
  PackageManager,
  PackageOutdatedDependency,
} from "../types";
import { palette } from "../theme/palette";

// Console-only debug logging. (It used to mirror to a hardcoded path on another
// machine and fire an IPC file write — with an ever-growing buffer — on EVERY
// cursor move, which wasted resources and hurt editor responsiveness.)
function glLog(...args: unknown[]) {
  console.debug("[Git Fluent]", ...args);
}

interface EditorPaneProps {
  file: OpenFile | null;
  /** Absolute path of the workspace root — needed for git blame. */
  rootPath: string | null;
  onChange: (value: string) => void;
  onCursorChange: (line: number, col: number) => void;
  /** Emits the current diagnostics whenever Monaco's markers change. */
  onProblemsChange: (problems: Problem[]) => void;
  /**
   * Imperatively reveals a line; set by the parent to jump from search/problems.
   * An optional `selection` highlights (selects) a range on that line — used by
   * search results to highlight the matched term in the editor.
   */
  revealRef?: React.MutableRefObject<
    ((line: number, selection?: MatchSelection) => void) | null
  >;
  /** A line (+ optional selection) to reveal as soon as the editor mounts. */
  pendingReveal?: React.MutableRefObject<{
    line: number;
    selection?: MatchSelection;
  } | null>;
  /**
   * Imperative bridge the App holds to drive the editor (run actions, trigger
   * commands, focus). The Edit/Selection menus from ISSUE-52 depend on it.
   */
  actionsRef?: React.MutableRefObject<EditorActionsApi | null>;
  /**
   * Opens a definition target that lives in another file (go-to-definition /
   * Ctrl+Click across files). The app loads the file into a tab and reveals the
   * line. Same-file jumps are handled by Monaco itself.
   */
  onOpenDefinition?: (path: string, line: number, column: number) => void;
  /** Opens the Source Control panel focused on this file's Git history. */
  onShowFileHistory?: (path: string, line?: number) => void;
  /** Opens a read-only view of this file at a commit, Git Fluent-style. */
  onOpenRevision?: (filePath: string, commitHash: string, shortHash: string) => void;
  /** Opens a diff for this file at a commit against previous/working tree. */
  onOpenRevisionDiff?: (
    filePath: string,
    commitHash: string,
    shortHash: string,
    compareTo: GitRevisionDiffTarget
  ) => void;
  /** Git/diagnostic decoration for this file, used for VS Code-like dirty diff. */
  fileDecoration?: FileDecoration;
  /** Emits the blame hunk for the current cursor line, used by the status bar. */
  onCurrentBlameChange?: (hunk: BlameHunk | null, filePath: string | null) => void;
}

/** Maps a Monaco marker severity (1/2/4/8) to our Problem severity. */
function mapSeverity(sev: number): Problem["severity"] {
  if (sev >= 8) return "error";
  if (sev >= 4) return "warning";
  return "info";
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function isDiffViewFile(file: OpenFile | null | undefined): boolean {
  if (!file) return false;
  const name = file.name.toLowerCase();
  const path = file.path.toLowerCase();
  return (
    name.endsWith(".diff") ||
    name.endsWith(".patch") ||
    path.startsWith("fluentcoder://git-diff/") ||
    path.startsWith("fluentcoder://git-working-diff/")
  );
}

function clampDirtyDiffLine(line: number, lineCount: number): number {
  return Math.max(1, Math.min(Math.max(lineCount, 1), line));
}

function parseDirtyDiffDecorations(
  diff: string,
  lineCount: number
): Array<{ line: number; kind: DirtyDiffKind }> {
  const decorations: Array<{ line: number; kind: DirtyDiffKind }> = [];
  const seen = new Set<string>();
  let newLine = 1;
  let inHunk = false;
  let pendingDeletedTargets: number[] = [];

  const push = (line: number, kind: DirtyDiffKind) => {
    const target = clampDirtyDiffLine(line, lineCount);
    const key = `${target}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    decorations.push({ line: target, kind });
  };

  const flushDeleted = () => {
    for (const target of pendingDeletedTargets) push(target, "deleted");
    pendingDeletedTargets = [];
  };

  for (const line of diff.split(/\r?\n/)) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flushDeleted();
      newLine = Number(hunk[1] || "1");
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("diff --git ") || line.startsWith("@@ ")) {
      flushDeleted();
      inHunk = false;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("--- ")) {
      pendingDeletedTargets.push(newLine);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      if (pendingDeletedTargets.length > 0) {
        pendingDeletedTargets.shift();
        push(newLine, "modified");
      } else {
        push(newLine, "added");
      }
      newLine++;
      continue;
    }

    flushDeleted();
    if (line.startsWith(" ") || line.length === 0 || line.startsWith("\\ No newline")) {
      if (!line.startsWith("\\ No newline")) newLine++;
    }
  }

  flushDeleted();
  return decorations;
}

/** CSS class for the inline blame annotation shown on the cursor line. */
const BLAME_ACTIVE_CLASS = "git-fluent-inline-active";
const PACKAGE_OUTDATED_CLASS = "package-inline-outdated";
const PACKAGE_SECURITY_CLASS = "package-inline-security";
type GitFileAnnotationMode = "off" | "blame" | "heatmap";
type DirtyDiffKind = "added" | "modified" | "deleted";
const GIT_FILE_ANNOTATION_MODE_STORAGE_KEY = "fluent.git.fileAnnotationMode";

const COMMAND_COPY_COMMIT = "fluent.git.copyCommitHash";
const COMMAND_FILE_HISTORY = "fluent.git.showFileHistory";
const COMMAND_LINE_HISTORY = "fluent.git.showLineHistory";
const COMMAND_OPEN_REMOTE_COMMIT = "fluent.git.openRemoteCommit";
const COMMAND_OPEN_LINE_REVISION = "fluent.git.openLineRevision";
const COMMAND_OPEN_LINE_CHANGES = "fluent.git.openLineChanges";
const COMMAND_PACKAGE_APPLY_VERSION = "fluent.package.applyVersion";
const COMMAND_PACKAGE_OPEN_REGISTRY = "fluent.package.openRegistry";
const GIT_CODELENS_LANGUAGES = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "json",
  "jsonc",
  "html",
  "css",
  "scss",
  "less",
  "markdown",
  "rust",
  "python",
  "go",
  "java",
  "c",
  "cpp",
  "dart",
  "csharp",
  "cshtml",
  "aspnetcorerazor",
  "php",
  "ruby",
  "shell",
  "yaml",
  "ini",
  "xml",
  "sql",
  "lua",
  "swift",
  "kotlin",
  "dockerfile",
  "plaintext",
];
// Future Settings hook: while the app has no settings UI, dependency inline
// intelligence is enabled by default, like the user requested. When Settings
// exists, this constant should read the user's preference instead.
const PACKAGE_INLINE_INTEL_DEFAULT_ENABLED = true;

function initialGitFileAnnotationMode(): GitFileAnnotationMode {
  try {
    const value = window.localStorage.getItem(GIT_FILE_ANNOTATION_MODE_STORAGE_KEY);
    if (value === "blame" || value === "heatmap" || value === "off") return value;
  } catch {
    // localStorage can be unavailable in tests or hardened webviews.
  }
  return "off";
}

function isPackageManifest(path: string): boolean {
  return baseName(path) === "package.json";
}

function packageInlineSummary(
  state: PackageInlineState,
  audit?: ReturnType<typeof inlineAuditStateForPackageJson>
): string {
  const auditSuffix =
    audit?.status === "checking"
      ? " · audit…"
      : audit?.status === "ready"
        ? audit.summary.total > 0
          ? ` · ⚠ ${audit.summary.total}`
          : " · 🛡 0"
        : audit?.status === "error"
          ? " · segurança?"
          : "";

  switch (state.status) {
    case "checking":
      return `${state.manager ?? "CLI"} · verificando…${auditSuffix}`;
    case "ready":
      return state.outdated.size === 0
        ? `${state.manager} · ✓${auditSuffix}`
        : `${state.manager} · × ${state.outdated.size}${auditSuffix}`;
    case "unsupported":
      return `${state.manager} · versões?${auditSuffix}`;
    case "needsSelection":
      return `Escolha CLI · ${state.managers.join(" / ")}`;
    case "error":
      return `× checar versões${auditSuffix}`;
    case "idle":
    default:
      return `Aguardando versões${auditSuffix}`;
  }
}

function applyRecommendedPackageVersions(
  content: string,
  state: PackageInlineState,
  target: "wanted" | "latest"
): { content: string; changed: number } {
  if (state.status !== "ready" || state.outdated.size === 0) {
    return { content, changed: 0 };
  }

  let changed = 0;
  let depSectionIndent: number | null = null;
  const lines = content.split(/\r?\n/);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const nextLines = lines.map((line) => {
    const section = line.match(
      /^(\s*)"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/
    );
    if (section) {
      depSectionIndent = section[1].length;
      return line;
    }
    if (depSectionIndent !== null) {
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= depSectionIndent && /^\s*}/.test(line)) {
        depSectionIndent = null;
        return line;
      }
    }
    if (depSectionIndent === null) return line;

    const dep = line.match(/^(\s*"([^"]+)"\s*:\s*")([^"]+)(".*)$/);
    if (!dep) return line;
    const [, prefix, name, current, suffix] = dep;
    const info = state.outdated.get(name);
    const recommended = recommendedVersion(current, info, target);
    if (!recommended || recommended === current) return line;
    changed++;
    return `${prefix}${recommended}${suffix}`;
  });

  return { content: nextLines.join(newline), changed };
}

function recommendedVersion(
  declared: string,
  info: PackageOutdatedDependency | undefined,
  target: "wanted" | "latest"
): string | null {
  if (!info) return null;
  const raw = target === "latest" ? info.latest ?? info.wanted : info.wanted ?? info.latest;
  if (!raw) return null;
  // Keep common semver range operators for the safer "wanted" action. If the
  // package manager already returned a ranged value, use it verbatim.
  if (/^[~^<>=*]/.test(raw) || target === "latest") return raw;
  const prefix = declared.match(/^(\^|~)/)?.[1] ?? "";
  return `${prefix}${raw}`;
}

function packageVersionRows(
  declared: string,
  info: PackageOutdatedDependency | null
): Array<{ label: string; value: string; selected?: boolean; tone?: "danger" | "ok" }> {
  const rows = new Map<string, { label: string; value: string; selected?: boolean; tone?: "danger" | "ok" }>();
  const push = (row: { label: string; value?: string | null; selected?: boolean; tone?: "danger" | "ok" }) => {
    if (!row.value) return;
    rows.set(row.label, {
      label: row.label,
      value: row.value,
      selected: Boolean(row.selected),
      tone: row.tone,
    });
  };

  push({ label: "Selecionada", value: declared, selected: true });
  if (info) {
    const wanted = recommendedVersion(declared, info, "wanted");
    const latest = recommendedVersion(declared, info, "latest");
    push({ label: "Instalada", value: info.current });
    push({ label: "Compatível", value: wanted, tone: "ok" });
    if (latest !== wanted) push({ label: "Latest", value: latest, tone: "danger" });
    else push({ label: "Latest", value: latest, tone: "danger" });
  }

  return Array.from(rows.values());
}

function auditSummaryLabel(audit: ReturnType<typeof inlineAuditStateForPackageJson>): string {
  if (audit.status === "checking") return `Audit${audit.manager ? ` com ${audit.manager}` : ""}…`;
  if (audit.status === "error") return "Audit: cheque segurança";
  if (audit.status === "ready") {
    return audit.summary.total === 0
      ? "Segurança: 0 vulnerabilidades"
      : `Segurança: ${audit.summary.total} vulnerabilidade(s)`;
  }
  return "Audit segurança";
}

function auditSeverityClass(summary: PackageAuditSummary): string {
  if (summary.critical > 0 || summary.high > 0) return "risk-high";
  if (summary.moderate > 0 || summary.low > 0) return "risk-medium";
  return "risk-ok";
}

function auditVulnerabilityTone(severity: string): "critical" | "high" | "medium" | "low" {
  const normalized = severity.toLowerCase();
  if (normalized === "critical") return "critical";
  if (normalized === "high") return "high";
  if (normalized === "moderate" || normalized === "medium") return "medium";
  return "low";
}

function auditSeverityLabel(severity: string): string {
  const normalized = severity.toLowerCase();
  if (normalized === "critical") return "crítica";
  if (normalized === "high") return "alta";
  if (normalized === "moderate" || normalized === "medium") return "moderada";
  if (normalized === "low") return "baixa";
  return severity || "desconhecida";
}

function initialsForAuthor(author: string): string {
  const parts = author.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function avatarColor(author: string): string {
  let hash = 0;
  for (const char of author) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 58%, 48%)`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function commandUri(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function npmPackageUrl(packageName: string): string {
  return `https://www.npmjs.com/package/${packageName}`;
}

function stripVersionRange(version: string): string {
  return version.replace(/^[\s~^<>=*]+/, "").trim();
}

function semverParts(version: string): { major: number; minor: number; patch: number; pre: string } | null {
  const cleaned = stripVersionRange(version).replace(/^v/i, "");
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1] ?? 0),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre: match[4] ?? "",
  };
}

function compareSemverDesc(a: string, b: string): number {
  const av = semverParts(a);
  const bv = semverParts(b);
  if (!av && !bv) return b.localeCompare(a);
  if (!av) return 1;
  if (!bv) return -1;
  for (const key of ["major", "minor", "patch"] as const) {
    if (av[key] !== bv[key]) return bv[key] - av[key];
  }
  if (av.pre && !bv.pre) return 1;
  if (!av.pre && bv.pre) return -1;
  return bv.pre.localeCompare(av.pre);
}

function isPrereleaseVersion(version: string): boolean {
  return Boolean(semverParts(version)?.pre);
}

function applyDeclaredRangePrefix(declared: string, version: string): string {
  const prefix = declared.match(/^(\^|~)/)?.[1] ?? "";
  return prefix ? `${prefix}${stripVersionRange(version)}` : version;
}

function newestStableVersion(versions: string[]): string | null {
  return [...new Set(versions.map(stripVersionRange).filter(Boolean))]
    .filter((version) => !isPrereleaseVersion(version))
    .sort(compareSemverDesc)[0] ?? null;
}

function findDependencyVersionAtPosition(
  model: editor.ITextModel,
  monaco: typeof import("monaco-editor"),
  position: { lineNumber: number; column: number }
): { name: string; declared: string; range: import("monaco-editor").Range } | null {
  let depSectionIndent: number | null = null;
  for (let line = 1; line <= Math.min(position.lineNumber, model.getLineCount()); line++) {
    const text = model.getLineContent(line);
    const section = text.match(
      /^(\s*)"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/
    );
    if (section) {
      depSectionIndent = section[1].length;
      continue;
    }
    if (depSectionIndent !== null) {
      const indent = text.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= depSectionIndent && /^\s*}/.test(text)) {
        depSectionIndent = null;
        continue;
      }
    }
    if (line !== position.lineNumber || depSectionIndent === null) continue;

    const match = text.match(/^(\s*)"([^"]+)"\s*:\s*"([^"]*)"/);
    if (!match) return null;
    const [, , name, declared] = match;
    const colonIndex = text.indexOf(":");
    const versionQuoteIndex = colonIndex >= 0 ? text.indexOf(`"${declared}"`, colonIndex) : -1;
    if (versionQuoteIndex < 0) return null;
    const startColumn = versionQuoteIndex + 2;
    const endColumn = startColumn + declared.length;
    if (position.column < startColumn || position.column > endColumn) return null;
    return {
      name,
      declared,
      range: new monaco.Range(line, startColumn, line, endColumn),
    };
  }

  return null;
}

function fallbackAvatarDataUri(author: string): string {
  const initials = initialsForAuthor(author);
  const color = avatarColor(author);
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="14" fill="${color}"/>
      <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="700" fill="#fff">${initials}</text>
    </svg>`
  );
  return `data:image/svg+xml,${svg}`;
}

function blameAvatarSrc(hunk: BlameHunk): string {
  return hunk.avatarUrl || fallbackAvatarDataUri(hunk.author);
}

function blameDisplayName(hunk: BlameHunk): string {
  return hunk.isCurrentUser ? "You" : hunk.author;
}

interface GitCodeLensSummary {
  recent: GitCommit | null;
  authorCount: number;
  primaryAuthor: string;
}

function gitCodeLensCacheKey(root: string, filePath: string, connId?: string): string {
  return `${connId ?? "local"}::${normalizePathForCompare(root)}::${normalizePathForCompare(filePath)}`;
}

function authorsSummaryFromBlame(hunks: BlameHunk[]): { count: number; primary: string } {
  const counts = new Map<string, number>();
  for (const hunk of hunks) {
    if (!hunk.author) continue;
    counts.set(hunk.author, (counts.get(hunk.author) ?? 0) + 1);
  }
  let primary = "";
  let max = 0;
  for (const [author, count] of counts) {
    if (count > max) {
      primary = author;
      max = count;
    }
  }
  return { count: counts.size, primary };
}

async function loadGitCodeLensSummary(
  root: string,
  filePath: string,
  connId?: string
): Promise<GitCodeLensSummary | null> {
  const [recent, hunks] = await Promise.all([
    gitLogFile(root, filePath, 1, connId).catch(() => [] as GitCommit[]),
    gitBlame(root, filePath, connId).catch(() => [] as BlameHunk[]),
  ]);
  if (recent.length === 0 && hunks.length === 0) return null;
  const authors = authorsSummaryFromBlame(hunks);
  return {
    recent: recent[0] ?? null,
    authorCount: authors.count,
    primaryAuthor: authors.primary,
  };
}

function gitCodeLensTitles(summary: GitCodeLensSummary): string[] {
  const titles: string[] = [];
  if (summary.recent) {
    const author = summary.recent.isCurrentUser ? "You" : summary.recent.author;
    titles.push(
      `Última alteração ${author}, ${summary.recent.date} • ${summary.recent.subject}`
    );
  }
  if (summary.authorCount > 0) {
    const label = summary.authorCount === 1 ? "1 autor" : `${summary.authorCount} autores`;
    titles.push(
      summary.primaryAuthor ? `${label} • ${summary.primaryAuthor}` : label
    );
  }
  return titles;
}

function blameAgeBucket(date: string): "hot" | "warm" | "cool" | "cold" {
  const normalized = date.toLowerCase();
  const amount = Number(normalized.match(/(\d+)/)?.[1] ?? "0");
  if (
    normalized.includes("agora") ||
    normalized.includes("min") ||
    normalized.includes("hora") ||
    /\bh\b/.test(normalized)
  ) {
    return "hot";
  }
  if (normalized.includes("dia")) return amount <= 14 ? "warm" : "cool";
  if (normalized.includes("semana")) return amount <= 4 ? "warm" : "cool";
  if (normalized.includes("mês") || normalized.includes("mes")) return "cool";
  return "cold";
}

function blameHoverMarkdown(hunk: BlameHunk, filePath?: string) {
  const displayName = escapeHtml(blameDisplayName(hunk));
  const authorName = escapeHtml(hunk.author);
  const email = escapeHtml(hunk.authorEmail || "");
  const date = escapeHtml(hunk.date || "agora");
  const hash = escapeHtml(hunk.hash || hunk.short || "");
  const shortHash = escapeHtml(hunk.short || hunk.hash.slice(0, 7));
  const rawHash = hunk.hash || hunk.short || "";
  const subject = escapeHtml(hunk.subject || "Linha ainda não commitada.");
  const avatar = escapeHtml(blameAvatarSrc(hunk));
  const additions = hunk.additions ?? 0;
  const deletions = hunk.deletions ?? 0;
  const changeSummary =
    additions > 0 || deletions > 0
      ? `<span class="fc-blame-diff"><span class="add">+${additions}</span><span class="del">−${deletions}</span></span>`
      : "";
  const copyUri = commandUri(COMMAND_COPY_COMMIT, [rawHash]);
  const historyUri = filePath ? commandUri(COMMAND_FILE_HISTORY, [filePath]) : "";
  const lineHistoryUri =
    filePath && hunk.line ? commandUri(COMMAND_LINE_HISTORY, [filePath, hunk.line]) : "";
  const revisionUri =
    filePath && rawHash ? commandUri(COMMAND_OPEN_LINE_REVISION, [filePath, rawHash, shortHash]) : "";
  const previousDiffUri =
    filePath && rawHash
      ? commandUri(COMMAND_OPEN_LINE_CHANGES, [filePath, rawHash, shortHash, "previous"])
      : "";
  const workingDiffUri =
    filePath && rawHash
      ? commandUri(COMMAND_OPEN_LINE_CHANGES, [filePath, rawHash, shortHash, "working"])
      : "";
  const remoteUri = hunk.remoteUrl ? commandUri(COMMAND_OPEN_REMOTE_COMMIT, [hunk.remoteUrl]) : "";
  const secondaryAuthor =
    hunk.isCurrentUser && hunk.author ? `<span class="fc-blame-author-name">${authorName}</span>` : "";
  const fileNameLabel = filePath ? escapeHtml(baseName(filePath)) : "";

  if (!hunk.short) {
    return {
      value: [
        `<div class="fc-hover-card fc-blame-card">`,
        `<div class="fc-blame-head">`,
        `<img class="fc-blame-avatar" src="${avatar}" width="32" height="32" alt="">`,
        `<div class="fc-blame-identity">`,
        `<div class="fc-blame-title"><strong>${displayName}</strong>${secondaryAuthor}</div>`,
        `<div class="fc-blame-subtitle">Linha ainda não commitada</div>`,
        `</div>`,
        `</div>`,
        `</div>`,
      ].join("\n"),
      supportHtml: true,
    };
  }

  return {
    value: [
      `<div class="fc-hover-card fc-blame-card">`,
      `<div class="fc-blame-head">`,
      `<img class="fc-blame-avatar" src="${avatar}" width="32" height="32" alt="">`,
      `<div class="fc-blame-identity">`,
      `<div class="fc-blame-title"><strong>${displayName}</strong>${secondaryAuthor}<span class="fc-blame-date"><span class="codicon codicon-history"></span> ${date}</span></div>`,
      `<div class="fc-blame-message">${subject}</div>`,
      `</div>`,
      `</div>`,
      `<div class="fc-blame-actions">`,
      `<a class="fc-blame-action primary" href="${copyUri}" title="Copiar hash do commit"><span class="codicon codicon-git-commit"></span>${shortHash}</a>`,
      `<a class="fc-blame-action" href="${copyUri}" title="Copiar hash"><span class="codicon codicon-copy"></span></a>`,
      historyUri ? `<a class="fc-blame-action" href="${historyUri}" title="Abrir histórico do arquivo"><span class="codicon codicon-history"></span></a>` : "",
      lineHistoryUri ? `<a class="fc-blame-action" href="${lineHistoryUri}" title="Abrir histórico desta linha"><span class="codicon codicon-list-selection"></span></a>` : "",
      previousDiffUri ? `<a class="fc-blame-action" href="${previousDiffUri}" title="Abrir alterações desta revisão"><span class="codicon codicon-diff"></span></a>` : "",
      workingDiffUri ? `<a class="fc-blame-action" href="${workingDiffUri}" title="Comparar esta revisão com o arquivo atual"><span class="codicon codicon-diff-multiple"></span></a>` : "",
      remoteUri ? `<a class="fc-blame-action" href="${remoteUri}" title="Abrir commit remoto"><span class="codicon codicon-link-external"></span></a>` : "",
      `<span class="fc-blame-separator"></span>`,
      revisionUri ? `<a class="fc-blame-action text" href="${revisionUri}">Abrir versão</a>` : "",
      previousDiffUri ? `<a class="fc-blame-action text" href="${previousDiffUri}">Alterações</a>` : "",
      lineHistoryUri ? `<a class="fc-blame-action text" href="${lineHistoryUri}">Histórico da linha</a>` : "",
      historyUri ? `<a class="fc-blame-action text" href="${historyUri}">Arquivo</a>` : "",
      remoteUri
        ? `<a class="fc-blame-action text" href="${remoteUri}">Remoto</a>`
        : `<span class="fc-blame-action text muted">Sem remoto</span>`,
      `</div>`,
      `<div class="fc-blame-frame">`,
      `<div class="fc-blame-section-title">Changes added in ${shortHash}</div>`,
      `<div class="fc-blame-meta-grid">`,
      `<span>Commit</span><code>${hash}</code>`,
      `<span>Autor</span><span>${displayName}${email ? ` · ${email}` : ""}</span>`,
      fileNameLabel ? `<span>Arquivo</span><span>${fileNameLabel}</span>` : "",
      `<span>Resumo</span><span>${subject}${changeSummary}</span>`,
      `</div>`,
      `</div>`,
      `</div>`,
    ].join("\n"),
    supportHtml: true,
    supportThemeIcons: true,
    isTrusted: {
      enabledCommands: [
        COMMAND_COPY_COMMIT,
        COMMAND_FILE_HISTORY,
        COMMAND_LINE_HISTORY,
        COMMAND_OPEN_REMOTE_COMMIT,
        COMMAND_OPEN_LINE_REVISION,
        COMMAND_OPEN_LINE_CHANGES,
      ],
    },
  };
}

function packageVersionHoverMarkdown(
  name: string,
  declared: string,
  info: PackageOutdatedDependency | null,
  filePath: string,
  availableVersions: string[] = [],
  statusMessage = "",
  vulnerabilities: PackageAuditVulnerability[] = []
) {
  const rows = packageVersionRows(declared, info);
  if (!info) return null;
  const latest = recommendedVersion(declared, info, "latest") ?? info.latest;
  const installed = info.current ?? declared;
  const registryUri = commandUri(COMMAND_PACKAGE_OPEN_REGISTRY, [npmPackageUrl(name)]);
  const selectedVersion = stripVersionRange(declared);
  const stable = newestStableVersion([
    ...availableVersions,
    stripVersionRange(info.wanted ?? ""),
    stripVersionRange(info.latest ?? ""),
  ]);
  const rowsWithStable = stable
    ? [
        ...rows,
        {
          label: "Stable",
          value: applyDeclaredRangePrefix(declared, stable),
          tone: "ok" as const,
        },
      ]
    : rows;
  const versionCandidates = Array.from(
    new Set(
      [
        ...availableVersions,
        stable ?? "",
        stripVersionRange(recommendedVersion(declared, info, "wanted") ?? ""),
        stripVersionRange(recommendedVersion(declared, info, "latest") ?? ""),
      ].filter(Boolean)
    )
  )
    .sort(compareSemverDesc)
    .slice(0, 10);
  const rowsHtml = rowsWithStable
    .map((row) => {
      const canApply = !row.selected && row.value !== declared;
      const applyUri = canApply
        ? commandUri(COMMAND_PACKAGE_APPLY_VERSION, [filePath, name, row.value])
        : "";
      const classes = [
        "fc-package-row",
        canApply ? "actionable" : "",
        row.selected ? "selected" : "",
        row.tone ? `tone-${row.tone}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const value = escapeHtml(row.value);
      const valueHtml = canApply
        ? `<a class="fc-package-version-link" href="${applyUri}" title="Fixar ${value} no package.json"><code>${value}</code><span>Fixar</span></a>`
        : `<code>${value}</code>`;
      return `<div class="${classes}"><span>${escapeHtml(row.label)}</span>${valueHtml}</div>`;
    })
    .join("");
  const versionListHtml = versionCandidates
    .map((version) => {
      const isSelected = version === selectedVersion;
      const isStable = stable === version;
      const isPrerelease = isPrereleaseVersion(version);
      const targetVersion = applyDeclaredRangePrefix(declared, version);
      const uri = commandUri(COMMAND_PACKAGE_APPLY_VERSION, [filePath, name, targetVersion]);
      const classes = [
        "fc-package-version-item",
        isSelected ? "selected" : "",
        isStable ? "stable" : "",
        isPrerelease ? "prerelease" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const badge = isSelected
        ? "Selecionada"
        : isStable
          ? "Stable"
          : isPrerelease
            ? "pré-release"
            : "";
      return isSelected
        ? `<span class="${classes}"><code>${escapeHtml(targetVersion)}</code><span>${badge}</span></span>`
        : `<a class="${classes}" href="${uri}" title="Fixar ${escapeHtml(targetVersion)}"><code>${escapeHtml(targetVersion)}</code>${badge ? `<span>${badge}</span>` : ""}</a>`;
    })
    .join("");
  const vulnerabilitiesHtml = packageSecurityHtml(vulnerabilities);

  return {
    value: [
      `<div class="fc-hover-card fc-package-card">`,
      `<div class="fc-package-title"><strong>${escapeHtml(name)}</strong><span class="tone-danger">✕ Versão mais recente disponível</span></div>`,
      `<div class="fc-package-summary">`,
      latest ? `<div>Versão mais recente: <strong>${escapeHtml(latest)}</strong></div>` : "",
      installed ? `<div>Versão instalada: <strong>${escapeHtml(installed)}</strong></div>` : "",
      `</div>`,
      `<div class="fc-package-heading">Versions <a href="${registryUri}">(View package)</a><span class="fc-package-copy">⧉</span></div>`,
      `<div class="fc-package-rows">${rowsHtml}</div>`,
      statusMessage ? `<div class="fc-package-note">${escapeHtml(statusMessage)}</div>` : "",
      vulnerabilitiesHtml,
      versionListHtml
        ? `<div class="fc-package-version-list" aria-label="Versões disponíveis">${versionListHtml}</div>`
        : "",
      `</div>`,
    ].join("\n"),
    supportHtml: true,
    isTrusted: {
      enabledCommands: [COMMAND_PACKAGE_APPLY_VERSION, COMMAND_PACKAGE_OPEN_REGISTRY],
    },
  };
}

function packageSecurityHtml(vulnerabilities: PackageAuditVulnerability[]): string {
  return vulnerabilities.length
    ? [
        `<div class="fc-package-security">`,
        `<div class="fc-package-security-title"><span class="codicon codicon-warning"></span> Segurança · ${vulnerabilities.length} alerta(s)</div>`,
        ...vulnerabilities.slice(0, 4).map((vulnerability) => {
          const tone = auditVulnerabilityTone(vulnerability.severity);
          const title = escapeHtml(vulnerability.title || vulnerability.package);
          const range = vulnerability.range ? ` <code>${escapeHtml(vulnerability.range)}</code>` : "";
          const url = vulnerability.url
            ? `<a href="${escapeHtml(vulnerability.url)}">advisory</a>`
            : "";
          return `<div class="fc-package-security-row ${tone}"><span>${auditSeverityLabel(vulnerability.severity)}</span><strong>${title}</strong>${range}${url}</div>`;
        }),
        vulnerabilities.length > 4
          ? `<div class="fc-package-security-more">+${vulnerabilities.length - 4} alerta(s) neste pacote</div>`
          : "",
        `</div>`,
      ].join("")
    : "";
}

function packageSecurityHoverMarkdown(
  name: string,
  declared: string,
  vulnerabilities: PackageAuditVulnerability[]
) {
  if (vulnerabilities.length === 0) return null;
  return {
    value: [
      `<div class="fc-hover-card fc-package-card">`,
      `<div class="fc-package-title"><strong>${escapeHtml(name)}</strong><span class="tone-danger">⚠ segurança</span></div>`,
      `<div class="fc-package-summary">`,
      `<div>Versão declarada: <strong>${escapeHtml(declared)}</strong></div>`,
      `</div>`,
      packageSecurityHtml(vulnerabilities),
      `</div>`,
    ].join("\n"),
    supportHtml: true,
  };
}

/**
 * Monaco's editor opener is a global, single registration. We register it once
 * and route through a ref so it always sees the latest `onOpenDefinition`.
 */
let openerRegistered = false;
let gitHoverCommandsRegistered = false;
let gitCodeLensProviderRegistered = false;
let packageVersionHoverProviderRegistered = false;
const openDefinitionRef: { current: ((p: string, l: number, c: number) => void) | null } = {
  current: null,
};
const gitHoverActionsRef: {
  copyCommit: ((hash: string) => void) | null;
  showFileHistory: ((path: string, line?: number) => void) | null;
  openRemoteCommit: ((url: string) => void) | null;
  openRevision: ((filePath: string, commitHash: string, shortHash: string) => void) | null;
  openRevisionDiff:
    | ((
        filePath: string,
        commitHash: string,
        shortHash: string,
        compareTo: GitRevisionDiffTarget
      ) => void)
    | null;
} = {
  copyCommit: null,
  showFileHistory: null,
  openRemoteCommit: null,
  openRevision: null,
  openRevisionDiff: null,
};
let packageHoverCommandsRegistered = false;
const packageHoverActionsRef: {
  applyVersion: ((filePath: string, packageName: string, version: string) => void) | null;
  openRegistry: ((url: string) => void) | null;
} = {
  applyVersion: null,
  openRegistry: null,
};
const packageHoverContextRef: {
  rootPath: string | null;
  connId?: string;
} = {
  rootPath: null,
  connId: undefined,
};
const gitCodeLensContextRef: {
  rootPath: string | null;
  connId?: string;
} = {
  rootPath: null,
  connId: undefined,
};
const gitCodeLensCache = new Map<string, Promise<GitCodeLensSummary | null>>();
const gitBlameCacheByFile = new Map<string, Map<number, BlameHunk>>();

function gitBlameCacheKey(filePath: string, root?: string | null, connId?: string): string {
  return `${connId ?? "local"}::${normalizePathForCompare(root ?? "")}::${normalizePathForCompare(filePath)}`;
}

function cachedBlameForLine(
  filePath: string,
  line: number,
  root?: string | null,
  connId?: string
): BlameHunk | undefined {
  return gitBlameCacheByFile.get(gitBlameCacheKey(filePath, root, connId))?.get(line);
}

export function EditorPane({
  file,
  rootPath,
  onChange,
  onCursorChange,
  onProblemsChange,
  revealRef,
  pendingReveal,
  actionsRef,
  onOpenDefinition,
  onShowFileHistory,
  onOpenRevision,
  onOpenRevisionDiff,
  fileDecoration,
  onCurrentBlameChange,
}: EditorPaneProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  // The v10 `@codingame` services must finish `initialize()` before the first
  // editor mounts (documented constraint) — `whenMonacoReady` also points
  // `@monaco-editor/react` at the shared Monaco instance. Gate the <Editor> on
  // it so the editor never mounts against a CDN/uninitialized Monaco.
  const [monacoReady, setMonacoReady] = useState(false);
  // If `initialize()` rejects (see vscodeServices.ts) `whenMonacoReady` never
  // resolves; without handling the rejection the pane would sit on the
  // "Carregando editor…" placeholder forever and Node/the browser would log an
  // unhandled promise rejection. Capture the failure so we can surface it
  // instead of hanging silently.
  const [monacoError, setMonacoError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    whenMonacoReady.then(
      () => {
        if (alive) setMonacoReady(true);
      },
      (err) => {
        if (alive) setMonacoError(err);
      }
    );
    return () => {
      alive = false;
    };
  }, []);
  // This editor's own reveal fn + actions api, set on mount. Kept internally so
  // we can (re)bind them to the parent's refs whenever THIS pane becomes the
  // active group — Monaco panes are not remounted on group switch, so binding
  // only on mount would leave go-to-line / Edit menus pointed at the old editor.
  const internalReveal = useRef<
    ((line: number, selection?: MatchSelection) => void) | null
  >(null);
  const internalApi = useRef<EditorActionsApi | null>(null);
  const packageRootPath = file?.workspaceRemote?.rootPath ?? rootPath;
  const packageConnId = file?.workspaceRemote?.connId;
  const gitRootPath = file?.workspaceRemote?.rootPath ?? rootPath;
  const gitConnId = file?.workspaceRemote?.connId;

  // Keep the global opener pointed at the current callback (it's a single
  // Monaco-wide registration, so it can't close over a stale prop).
  openDefinitionRef.current = onOpenDefinition ?? null;
  packageHoverContextRef.rootPath = packageRootPath;
  packageHoverContextRef.connId = packageConnId;
  gitCodeLensContextRef.rootPath = gitRootPath;
  gitCodeLensContextRef.connId = gitConnId;
  gitHoverActionsRef.copyCommit = (hash) => {
    if (!hash) return;
    void navigator.clipboard?.writeText(hash);
  };
  gitHoverActionsRef.showFileHistory = (path) => {
    if (!path) return;
    onShowFileHistory?.(path);
  };
  gitHoverActionsRef.openRemoteCommit = (url) => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };
  gitHoverActionsRef.openRevision = (path, hash, shortHash) => {
    if (!path || !hash) return;
    onOpenRevision?.(path, hash, shortHash || hash.slice(0, 7));
  };
  gitHoverActionsRef.openRevisionDiff = (path, hash, shortHash, compareTo) => {
    if (!path || !hash) return;
    onOpenRevisionDiff?.(path, hash, shortHash || hash.slice(0, 7), compareTo);
  };
  packageHoverActionsRef.applyVersion = (targetFilePath, packageName, version) => {
    applyPackageVersionFromHover(targetFilePath, packageName, version);
  };
  packageHoverActionsRef.openRegistry = (url) => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // Blame data keyed by line number (1-based).
  const blameRef = useRef<Map<number, BlameHunk>>(new Map());
  // IDs of active decorations so we can replace them atomically.
  const decorationIdsRef = useRef<string[]>([]);
  const fileAnnotationDecorationIdsRef = useRef<string[]>([]);
  const packageDecorationIdsRef = useRef<string[]>([]);
  const diffDecorationIdsRef = useRef<string[]>([]);
  const dirtyDiffDecorationIdsRef = useRef<string[]>([]);
  // Current cursor line to highlight a specific blame.
  const cursorLineRef = useRef<number>(1);
  const [gitFileAnnotationMode, setGitFileAnnotationMode] =
    useState<GitFileAnnotationMode>(() => initialGitFileAnnotationMode());
  const [hasGitFileAnnotations, setHasGitFileAnnotations] = useState(false);
  const packageIntelVersion = useSyncExternalStore(
    packageIntelSubscribe,
    packageIntelSnapshot,
    packageIntelSnapshot
  );

  async function recheckPackageJsonIntel(
    packageJsonPath: string,
    options: { force?: boolean; audit?: boolean } = {}
  ) {
    if (!packageRootPath) return;
    const force = options.force ?? true;
    await ensurePackageInlineCheck(packageRootPath, packageJsonPath, {
      force,
      connId: packageConnId,
    });

    // Audit uses the same chosen package manager, but unlike inline outdated
    // parsing it can still work for managers whose "outdated" output is not
    // safely parsed yet. The only hard stop is the explicit manager-selection
    // state; otherwise we try to surface security info just like Dependabot.
    if (options.audit === false) return;
    const nextState = inlineStateForPackageJson(packageJsonPath);
    if (nextState.status === "needsSelection") return;
    void ensurePackageAuditCheck(packageRootPath, packageJsonPath, {
      force,
      connId: packageConnId,
    });
  }
  // Debugger decorations (breakpoint glyphs + stopped-line highlight) — a
  // separate id set so blame and debug never clobber each other's decorations.
  const debugDecorationIdsRef = useRef<string[]>([]);

  /** Renders breakpoints + the stopped line for the CURRENT model (by uri). */
  const applyDebugDecorations = () => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    const model = ed.getModel();
    if (!model || model.isDisposed() || model.uri.scheme !== "file") return;
    const path = fromFileUri(model.uri.toString());
    const decs: editor.IModelDeltaDecoration[] = debugSession
      .breakpointsFor(path)
      .filter((line) => line <= model.getLineCount())
      .map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "debug-breakpoint-glyph",
          glyphMarginHoverMessage: { value: "Breakpoint" },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }));
    const stopped = debugSession.getState().stoppedAt;
    if (
      stopped &&
      canonicalFileUriKey(toFileUri(stopped.path)) === canonicalFileUriKey(model.uri.toString()) &&
      stopped.line <= model.getLineCount()
    ) {
      decs.push({
        range: new monaco.Range(stopped.line, 1, stopped.line, 1),
        options: {
          isWholeLine: true,
          className: "debug-stopped-line",
          glyphMarginClassName: "debug-stopped-glyph",
        },
      });
    }
    debugDecorationIdsRef.current = ed.deltaDecorations(debugDecorationIdsRef.current, decs);
  };

  // Re-render debug decorations whenever the session state changes (breakpoint
  // toggled anywhere, execution stopped/continued) — and on model switches.
  useEffect(() => debugSession.subscribe(applyDebugDecorations));

  // Bind THIS editor's reveal/actions to the parent refs whenever they're handed
  // to us (i.e. this pane became the active group) and clear them when they're
  // taken away or on unmount. React flushes all effect cleanups before all new
  // effects, so a group switch (old pane clears, new pane sets) ends with the
  // refs pointing at the newly-active editor.
  useEffect(() => {
    if (revealRef) revealRef.current = internalReveal.current;
    if (actionsRef) actionsRef.current = internalApi.current;
    return () => {
      if (revealRef) revealRef.current = null;
      if (actionsRef) actionsRef.current = null;
    };
  }, [revealRef, actionsRef]);

  // When there is no file, the <Editor> unmounts (empty-state below), so its
  // api is gone — clear both the internal cache and the parent bridge so the App
  // reports "no active editor" and can disable menu items.
  useEffect(() => {
    if (!file) {
      internalReveal.current = null;
      internalApi.current = null;
      if (actionsRef) actionsRef.current = null;
      if (revealRef) revealRef.current = null;
    }
  }, [file, actionsRef, revealRef]);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function findDependencyVersionRange(
    model: editor.ITextModel,
    monaco: typeof import("monaco-editor"),
    packageName: string
  ): { range: import("monaco-editor").Range; current: string } | null {
    let depSectionIndent: number | null = null;
    for (let line = 1; line <= model.getLineCount(); line++) {
      const text = model.getLineContent(line);
      const section = text.match(
        /^(\s*)"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/
      );
      if (section) {
        depSectionIndent = section[1].length;
        continue;
      }
      if (depSectionIndent !== null) {
        const indent = text.match(/^(\s*)/)?.[1].length ?? 0;
        if (indent <= depSectionIndent && /^\s*}/.test(text)) {
          depSectionIndent = null;
          continue;
        }
      }
      if (depSectionIndent === null) continue;

      const match = text.match(/^(\s*)"([^"]+)"\s*:\s*"([^"]*)"/);
      if (!match || match[2] !== packageName) continue;
      const current = match[3];
      const colonIndex = text.indexOf(":");
      const versionQuoteIndex = colonIndex >= 0 ? text.indexOf(`"${current}"`, colonIndex) : -1;
      if (versionQuoteIndex < 0) return null;
      const startColumn = versionQuoteIndex + 2;
      const endColumn = startColumn + current.length;
      return {
        current,
        range: new monaco.Range(line, startColumn, line, endColumn),
      };
    }

    return null;
  }

  function applyPackageVersionFromHover(
    targetFilePath: string,
    packageName: string,
    version: string
  ) {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !monaco || !model || !file) return;
    if (normalizePathForCompare(file.path) !== normalizePathForCompare(targetFilePath)) return;

    const target = findDependencyVersionRange(model, monaco, packageName);
    if (!target || target.current === version) return;

    ed.pushUndoStop();
    ed.executeEdits("fluent-package-intel", [
      {
        range: target.range,
        text: version,
        forceMoveMarkers: true,
      },
    ]);
    ed.pushUndoStop();
    onChange(model.getValue());
    applyPackageDecorations();
    ed.focus();
  }

  function publishCurrentBlame(line = cursorLineRef.current) {
    if (!file || !gitRootPath || file.path.startsWith("untitled:")) {
      onCurrentBlameChange?.(null, null);
      return;
    }
    onCurrentBlameChange?.(blameRef.current.get(line) ?? null, file.path);
  }

  function applyBlameDecorations() {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;

    const model = ed.getModel();
    const blame = blameRef.current;
    glLog("applyBlameDecorations, blame.size =", blame.size, "hasModel =", !!model);
    if (!model || blame.size === 0) {
      decorationIdsRef.current = ed.deltaDecorations(decorationIdsRef.current, []);
      return;
    }

    const cursorLine = cursorLineRef.current;
    const lineCount = model.getLineCount();
    const newDecorations: editor.IModelDeltaDecoration[] = [];

    // Like Git Fluent, the inline blame is shown only on the current cursor line,
    // not on every line of the file.
    const lineNum = cursorLine;
    const hunk = blame.get(lineNum);
    if (hunk && lineNum >= 1 && lineNum <= lineCount) {
      const authorLabel = blameDisplayName(hunk);
      const label = hunk.short
        ? `${authorLabel}, ${hunk.date} · ${hunk.short} ${hunk.subject}`
        : authorLabel;

      // Anchor the `after` decoration at the real end-of-line column. Using
      // MAX_SAFE_INTEGER here makes Monaco silently drop the decoration.
      const endCol = model.getLineMaxColumn(lineNum);
      newDecorations.push({
        range: new monaco.Range(lineNum, endCol, lineNum, endCol),
        options: {
          after: {
            content: `    ${label}`,
            inlineClassName: BLAME_ACTIVE_CLASS,
            // Sem isto o Monaco às vezes não reserva largura para o texto
            // injetado e a anotação fica com largura 0 (invisível).
            inlineClassNameAffectsLetterSpacing: true,
            // This is decoration text, not document text. Without this Monaco
            // allows the caret/selection to stop inside the injected label.
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
          // Hovering the Git Fluent inline author text should only show Git
          // history. Package/version intelligence is anchored to the dependency
          // version or the injected package marker, matching VS Code's target
          // separation while still letting version hovers prepend Git context.
          hoverMessage: blameHoverMarkdown(hunk, file?.path),
          showIfCollapsed: true,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }

    glLog("aplicando", newDecorations.length, "decorações; primeira:", newDecorations[0]?.options?.after?.content ?? "(nenhuma)");
    decorationIdsRef.current = ed.deltaDecorations(decorationIdsRef.current, newDecorations);
    glLog("ids após deltaDecorations:", decorationIdsRef.current.length);
  }

  function applyFileAnnotationDecorations() {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    const blame = blameRef.current;
    if (!ed || !monaco || !model || !file || gitFileAnnotationMode === "off" || blame.size === 0) {
      fileAnnotationDecorationIdsRef.current =
        ed?.deltaDecorations(fileAnnotationDecorationIdsRef.current, []) ?? [];
      return;
    }

    const lineCount = model.getLineCount();
    const decorations: editor.IModelDeltaDecoration[] = [];
    for (let line = 1; line <= lineCount; line++) {
      const hunk = blame.get(line);
      if (!hunk) continue;
      const bucket = blameAgeBucket(hunk.date || "");
      const isBlameMode = gitFileAnnotationMode === "blame";
      const className = isBlameMode
        ? "git-file-annotation-blame"
        : `git-file-annotation-heatmap git-file-annotation-${bucket}`;
      const overviewColor =
        bucket === "hot"
          ? "#60CDFF"
          : bucket === "warm"
            ? "#8FE0AD"
            : bucket === "cool"
              ? "#E2C08D"
              : "#7D8795";

      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          linesDecorationsClassName: className,
          overviewRuler: {
            color: isBlameMode ? "rgba(96, 205, 255, 0.42)" : overviewColor,
            position: monaco.editor.OverviewRulerLane.Right,
          },
          hoverMessage: blameHoverMarkdown(hunk, file.path),
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }

    fileAnnotationDecorationIdsRef.current = ed.deltaDecorations(
      fileAnnotationDecorationIdsRef.current,
      decorations
    );
  }

  function applyDiffDecorations() {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !monaco || !model || !isDiffViewFile(file)) {
      diffDecorationIdsRef.current =
        ed?.deltaDecorations(diffDecorationIdsRef.current, []) ?? [];
      return;
    }

    const decorations: editor.IModelDeltaDecoration[] = [];
    let previousChange: "added" | "removed" | null = null;
    for (let line = 1; line <= model.getLineCount(); line++) {
      const text = model.getLineContent(line);
      let kind:
        | "added"
        | "removed"
        | "modified-added"
        | "modified-removed"
        | "hunk"
        | "header"
        | null = null;

      if (/^(diff --git|index |new file mode|deleted file mode|similarity index|rename from |rename to )/.test(text)) {
        kind = "header";
        previousChange = null;
      } else if (text.startsWith("@@")) {
        kind = "hunk";
        previousChange = null;
      } else if (text.startsWith("--- ") || text.startsWith("+++ ")) {
        kind = "header";
        previousChange = null;
      } else if (text.startsWith("+")) {
        kind = previousChange === "removed" ? "modified-added" : "added";
        previousChange = "added";
      } else if (text.startsWith("-")) {
        kind = previousChange === "added" ? "modified-removed" : "removed";
        previousChange = "removed";
      } else {
        previousChange = null;
      }

      if (!kind) continue;

      const color =
        kind === "added"
          ? "rgba(46, 160, 67, 0.26)"
          : kind === "removed"
            ? "rgba(248, 81, 73, 0.25)"
            : kind === "modified-added"
              ? "rgba(46, 160, 67, 0.34)"
              : kind === "modified-removed"
                ? "rgba(248, 81, 73, 0.34)"
                : kind === "hunk"
                  ? "rgba(96, 205, 255, 0.34)"
                  : "rgba(125, 135, 149, 0.24)";

      decorations.push({
        range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
        options: {
          isWholeLine: true,
          className: `fc-diff-line fc-diff-line-${kind}`,
          linesDecorationsClassName: `fc-diff-gutter fc-diff-gutter-${kind}`,
          glyphMarginClassName: `fc-diff-glyph fc-diff-glyph-${kind}`,
          overviewRuler: {
            color,
            position: monaco.editor.OverviewRulerLane.Full,
          },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }

    diffDecorationIdsRef.current = ed.deltaDecorations(
      diffDecorationIdsRef.current,
      decorations
    );
  }

  function clearDirtyDiffDecorations() {
    dirtyDiffDecorationIdsRef.current =
      editorRef.current?.deltaDecorations(dirtyDiffDecorationIdsRef.current, []) ?? [];
  }

  function applyDirtyDiffDecorations(
    lineDecorations: Array<{ line: number; kind: DirtyDiffKind }>
  ) {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !monaco || !model || lineDecorations.length === 0) {
      clearDirtyDiffDecorations();
      return;
    }

    const decorations: editor.IModelDeltaDecoration[] = lineDecorations.map(
      ({ line, kind }) => {
        const color =
          kind === "added"
            ? "rgba(115, 201, 145, 0.72)"
            : kind === "modified"
              ? "rgba(96, 205, 255, 0.74)"
              : "rgba(255, 154, 168, 0.76)";
        return {
          range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
          options: {
            isWholeLine: true,
            className: `fc-dirty-diff-line fc-dirty-diff-line-${kind}`,
            linesDecorationsClassName: `fc-dirty-diff-gutter fc-dirty-diff-gutter-${kind}`,
            glyphMarginClassName: `fc-dirty-diff-glyph fc-dirty-diff-glyph-${kind}`,
            overviewRuler: {
              color,
              position: monaco.editor.OverviewRulerLane.Left,
            },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      }
    );

    dirtyDiffDecorationIdsRef.current = ed.deltaDecorations(
      dirtyDiffDecorationIdsRef.current,
      decorations
    );
  }

  function applyPackageDecorations() {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (
      !PACKAGE_INLINE_INTEL_DEFAULT_ENABLED ||
      !ed ||
      !monaco ||
      !model ||
      !file ||
      !isPackageManifest(file.path)
    ) {
      packageDecorationIdsRef.current =
        ed?.deltaDecorations(packageDecorationIdsRef.current, []) ?? [];
      return;
    }

    const state = inlineStateForPackageJson(file.path);
    const decorations: editor.IModelDeltaDecoration[] = [];
    let depSectionIndent: number | null = null;
    for (let line = 1; line <= model.getLineCount(); line++) {
      const text = model.getLineContent(line);
      const section = text.match(/^(\s*)"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/);
      if (section) {
        depSectionIndent = section[1].length;
        continue;
      }
      if (depSectionIndent !== null) {
        const indent = text.match(/^(\s*)/)?.[1].length ?? 0;
        if (indent <= depSectionIndent && /^\s*}/.test(text)) {
          depSectionIndent = null;
          continue;
        }
      }
      if (depSectionIndent === null) continue;
      const match = text.match(/^\s*"([^"]+)"\s*:\s*"([^"]+)"/);
      if (!match) continue;
      const [, name, declared] = match;
      const info = state.status === "ready" ? state.outdated.get(name) : null;
      const audit = inlineAuditStateForPackageJson(file.path);
      const vulnerabilities =
        audit.status === "ready" ? audit.byPackage.get(name.toLowerCase()) ?? [] : [];
      if (state.status !== "ready" && vulnerabilities.length === 0) continue;
      if (!info && vulnerabilities.length === 0) continue;
      const decoration = info
        ? {
            label: ` × ${recommendedVersion(declared, info, "wanted") ?? info.latest ?? "nova"}`,
            className: PACKAGE_OUTDATED_CLASS,
          }
        : {
            label: ` ⚠ segurança`,
            className: PACKAGE_SECURITY_CLASS,
          };
      const colonIndex = text.indexOf(":");
      const versionIndex = colonIndex >= 0 ? text.indexOf(`"${declared}"`, colonIndex) : -1;
      const versionStartCol = versionIndex >= 0 ? versionIndex + 1 : model.getLineMaxColumn(line);
      const versionEndCol =
        versionIndex >= 0 ? versionIndex + declared.length + 3 : model.getLineMaxColumn(line);
      const versionHover =
        info
          ? packageVersionHoverMarkdown(name, declared, info, file.path, [], "", vulnerabilities)
          : packageSecurityHoverMarkdown(name, declared, vulnerabilities);
      const blame = blameRef.current.get(line);
      const combinedHoverForInjectedText =
        versionHover && blame
          ? [blameHoverMarkdown(blame, file.path), versionHover]
          : versionHover;

      // Keep the package indicator anchored to the dependency version itself.
      // When the cursor line also has blame, Monaco receives both hover
      // sections and renders them together in the native editor hover.
      decorations.push({
        range: new monaco.Range(line, versionEndCol, line, versionEndCol),
        options: {
          after: {
            content: decoration.label,
            inlineClassName: decoration.className,
            inlineClassNameAffectsLetterSpacing: true,
            // Same as VS Code/Dependi: visual annotation only. The injected
            // version/check marker must not become part of text selection.
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
          hoverMessage: combinedHoverForInjectedText,
          showIfCollapsed: true,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
      if (versionIndex >= 0) {
        decorations.push({
          range: new monaco.Range(line, versionStartCol, line, versionEndCol),
          options: {
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });
      }
    }
    packageDecorationIdsRef.current = ed.deltaDecorations(
      packageDecorationIdsRef.current,
      decorations
    );
  }

  async function loadBlame() {
    const ed = editorRef.current;
    glLog("loadBlame", {
      hasEditor: !!ed,
      rootPath: gitRootPath,
      connId: gitConnId,
      filePath: file?.path,
    });
    if (!ed || !gitRootPath || !file) return;
    // Untitled buffers aren't on disk — no git blame to fetch.
    if (file.path.startsWith("untitled:")) return;

    try {
      const hunks = await gitBlame(gitRootPath, file.path, gitConnId);
      glLog("hunks recebidos:", hunks.length, "amostra:", hunks.slice(0, 2));
      const map = new Map<number, BlameHunk>();
      hunks.forEach((h) => map.set(h.line, h));
      blameRef.current = map;
      setHasGitFileAnnotations(map.size > 0);
      gitBlameCacheByFile.set(gitBlameCacheKey(file.path, gitRootPath, gitConnId), map);
      publishCurrentBlame();
      applyBlameDecorations();
      applyFileAnnotationDecorations();
    } catch (err) {
      // Not a git repo or file not tracked — silently skip blame.
      glLog("ERRO no gitBlame:", String(err));
      blameRef.current = new Map();
      setHasGitFileAnnotations(false);
      onCurrentBlameChange?.(null, file.path);
      gitBlameCacheByFile.delete(gitBlameCacheKey(file.path, gitRootPath, gitConnId));
      decorationIdsRef.current =
        editorRef.current?.deltaDecorations(decorationIdsRef.current, []) ?? [];
      fileAnnotationDecorationIdsRef.current =
        editorRef.current?.deltaDecorations(fileAnnotationDecorationIdsRef.current, []) ?? [];
    }
  }

  // -------------------------------------------------------------------------
  // Reload blame when the active file changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    blameRef.current = new Map();
    setHasGitFileAnnotations(false);
    onCurrentBlameChange?.(null, file?.path ?? null);
    decorationIdsRef.current =
      editorRef.current?.deltaDecorations(decorationIdsRef.current, []) ?? [];
    fileAnnotationDecorationIdsRef.current =
      editorRef.current?.deltaDecorations(fileAnnotationDecorationIdsRef.current, []) ?? [];
    diffDecorationIdsRef.current =
      editorRef.current?.deltaDecorations(diffDecorationIdsRef.current, []) ?? [];
    dirtyDiffDecorationIdsRef.current =
      editorRef.current?.deltaDecorations(dirtyDiffDecorationIdsRef.current, []) ?? [];
    if (gitRootPath && file?.path) {
      gitCodeLensCache.delete(gitCodeLensCacheKey(gitRootPath, file.path, gitConnId));
      gitBlameCacheByFile.delete(gitBlameCacheKey(file.path, gitRootPath, gitConnId));
    }

    if (file && gitRootPath) {
      loadBlame();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, gitRootPath, gitConnId]);

  useEffect(() => {
    applyDiffDecorations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, file?.content]);

  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const gitBadge = fileDecoration?.badge?.toUpperCase();
    const gitKind = fileDecoration?.kind;
    const hasGitChange =
      gitKind === "modified" ||
      gitKind === "added" ||
      gitKind === "untracked" ||
      gitKind === "deleted" ||
      gitKind === "conflict" ||
      gitBadge === "M" ||
      gitBadge === "A" ||
      gitBadge === "U" ||
      gitBadge === "D";

    if (
      !gitRootPath ||
      !file ||
      !model ||
      file.readOnly ||
      file.path.startsWith("untitled:") ||
      isDiffViewFile(file) ||
      !hasGitChange
    ) {
      clearDirtyDiffDecorations();
      return;
    }

    const lineCount = model.getLineCount();
    const isWholeFileAdded =
      gitKind === "untracked" ||
      gitKind === "added" ||
      gitBadge === "U" ||
      gitBadge === "A";

    if (isWholeFileAdded) {
      applyDirtyDiffDecorations(
        Array.from({ length: Math.max(lineCount, 1) }, (_, index) => ({
          line: index + 1,
          kind: "added" as DirtyDiffKind,
        }))
      );
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void gitDiffFile(gitRootPath, file.path, gitConnId)
        .then((diff) => {
          if (cancelled) return;
          const activeModel = editorRef.current?.getModel();
          if (!activeModel) {
            clearDirtyDiffDecorations();
            return;
          }
          const next = parseDirtyDiffDecorations(diff, activeModel.getLineCount());
          applyDirtyDiffDecorations(next);
        })
        .catch(() => {
          if (!cancelled) clearDirtyDiffDecorations();
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gitRootPath,
    gitConnId,
    file?.path,
    file?.content,
    file?.readOnly,
    fileDecoration?.kind,
    fileDecoration?.badge,
  ]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        GIT_FILE_ANNOTATION_MODE_STORAGE_KEY,
        gitFileAnnotationMode
      );
    } catch {
      // Non-fatal: the mode still works for this session.
    }
  }, [gitFileAnnotationMode]);

  useEffect(() => {
    applyFileAnnotationDecorations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitFileAnnotationMode, file?.path, hasGitFileAnnotations]);

  useEffect(() => {
    applyPackageDecorations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, file?.content, packageIntelVersion]);

  useEffect(() => {
    if (
      !PACKAGE_INLINE_INTEL_DEFAULT_ENABLED ||
      !packageRootPath ||
      !file ||
      !isPackageManifest(file.path)
    ) {
      return;
    }
    void recheckPackageJsonIntel(file.path, { force: true, audit: true });
  }, [packageRootPath, packageConnId, file?.path]);

  // -------------------------------------------------------------------------
  // Monaco setup
  // -------------------------------------------------------------------------

  const handleBeforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco;

    // LSP pipeline setup (idempotent): disable the built-in TS/JS worker so the
    // real typescript-language-server owns IntelliSense, register the React
    // language ids, and register the `razor` language + tokenizer. Must run
    // before any model is created.
    setupMonacoForLsp(monaco);

    // Register a Monaco editor opener ONCE so go-to-definition / Ctrl+Click that
    // lands in a DIFFERENT file opens that file in a tab. Monaco calls this when
    // a definition resolves to a URI other than the current model. Same-file
    // jumps return false so Monaco handles them itself.
    if (!openerRegistered) {
      openerRegistered = true;
      monaco.editor.registerEditorOpener({
        openCodeEditor(_source, resource, selectionOrPosition) {
          const currentUri = editorRef.current?.getModel()?.uri.toString();
          if (resource.toString() === currentUri) {
            return false; // same file — let Monaco reveal the position
          }
          const open = openDefinitionRef.current;
          if (!open) return false;
          // Extract a 1-based line/column from either a Range or a Position.
          let line = 1;
          let column = 1;
          if (selectionOrPosition) {
            if ("startLineNumber" in selectionOrPosition) {
              line = selectionOrPosition.startLineNumber;
              column = selectionOrPosition.startColumn;
            } else {
              line = selectionOrPosition.lineNumber;
              column = selectionOrPosition.column;
            }
          }
          open(fromFileUri(resource.toString()), line, column);
          return true; // we handled the cross-file open
        },
      });
    }

    if (!gitHoverCommandsRegistered) {
      gitHoverCommandsRegistered = true;
      monaco.editor.addCommand({
        id: COMMAND_COPY_COMMIT,
        run: (_accessor, hash: string) => gitHoverActionsRef.copyCommit?.(hash),
      });
      monaco.editor.addCommand({
        id: COMMAND_FILE_HISTORY,
        run: (_accessor, path: string) => gitHoverActionsRef.showFileHistory?.(path),
      });
      monaco.editor.addCommand({
        id: COMMAND_LINE_HISTORY,
        run: (_accessor, path: string, line: number) =>
          gitHoverActionsRef.showFileHistory?.(path, line),
      });
      monaco.editor.addCommand({
        id: COMMAND_OPEN_REMOTE_COMMIT,
        run: (_accessor, url: string) => gitHoverActionsRef.openRemoteCommit?.(url),
      });
      monaco.editor.addCommand({
        id: COMMAND_OPEN_LINE_REVISION,
        run: (_accessor, filePath: string, commitHash: string, shortHash: string) =>
          gitHoverActionsRef.openRevision?.(filePath, commitHash, shortHash),
      });
      monaco.editor.addCommand({
        id: COMMAND_OPEN_LINE_CHANGES,
        run: (
          _accessor,
          filePath: string,
          commitHash: string,
          shortHash: string,
          compareTo: GitRevisionDiffTarget
        ) =>
          gitHoverActionsRef.openRevisionDiff?.(
            filePath,
            commitHash,
            shortHash,
            compareTo
          ),
      });
    }
    if (!gitCodeLensProviderRegistered) {
      gitCodeLensProviderRegistered = true;
      for (const language of GIT_CODELENS_LANGUAGES) {
        monaco.languages.registerCodeLensProvider(language, {
          async provideCodeLenses(model) {
            const root = gitCodeLensContextRef.rootPath;
            const connId = gitCodeLensContextRef.connId;
            if (!root) return { lenses: [], dispose: () => {} };
            if (model.uri.scheme !== "file") return { lenses: [], dispose: () => {} };
            const filePath = fromFileUri(model.uri.toString());
            if (!filePath || filePath.startsWith("untitled:")) {
              return { lenses: [], dispose: () => {} };
            }

            const key = gitCodeLensCacheKey(root, filePath, connId);
            let request = gitCodeLensCache.get(key);
            if (!request) {
              request = loadGitCodeLensSummary(root, filePath, connId);
              gitCodeLensCache.set(key, request);
            }
            const summary = await request;
            if (!summary) return { lenses: [], dispose: () => {} };

            const range = new monaco.Range(1, 1, 1, 1);
            const lenses = gitCodeLensTitles(summary).map((title) => ({
              range,
              id: `${COMMAND_FILE_HISTORY}:${filePath}:${title}`,
              command: {
                id: COMMAND_FILE_HISTORY,
                title,
                arguments: [filePath],
              },
            }));
            return { lenses, dispose: () => {} };
          },
        });
      }
    }
    if (!packageHoverCommandsRegistered) {
      packageHoverCommandsRegistered = true;
      monaco.editor.addCommand({
        id: COMMAND_PACKAGE_APPLY_VERSION,
        run: (_accessor, filePath: string, packageName: string, version: string) =>
          packageHoverActionsRef.applyVersion?.(filePath, packageName, version),
      });
      monaco.editor.addCommand({
        id: COMMAND_PACKAGE_OPEN_REGISTRY,
        run: (_accessor, url: string) => packageHoverActionsRef.openRegistry?.(url),
      });
    }
    if (!packageVersionHoverProviderRegistered) {
      packageVersionHoverProviderRegistered = true;
      for (const language of ["json", "jsonc"]) {
        monaco.languages.registerHoverProvider(language, {
          async provideHover(model, position) {
            if (model.uri.scheme !== "file") return null;
            const filePath = fromFileUri(model.uri.toString());
            if (!isPackageManifest(filePath)) return null;
            const root = packageHoverContextRef.rootPath;
            const connId = packageHoverContextRef.connId;
            if (!root) return null;
            const hit = findDependencyVersionAtPosition(model, monaco, position);
            if (!hit) return null;
            const state = inlineStateForPackageJson(filePath);
            const info = state.status === "ready" ? state.outdated.get(hit.name) : null;
            const audit = inlineAuditStateForPackageJson(filePath);
            const vulnerabilities =
              audit.status === "ready" ? audit.byPackage.get(hit.name.toLowerCase()) ?? [] : [];
            const blame = cachedBlameForLine(
              filePath,
              position.lineNumber,
              gitCodeLensContextRef.rootPath,
              gitCodeLensContextRef.connId
            );

            if (!info) {
              const hover = packageSecurityHoverMarkdown(
                hit.name,
                hit.declared,
                vulnerabilities
              );
              if (!hover) return null;
              const contents = blame
                ? [blameHoverMarkdown(blame, filePath), hover]
                : [hover];
              return { range: hit.range, contents };
            }

            try {
              const report = await packageVersionsForHover(root, filePath, hit.name, connId);
              const hover = packageVersionHoverMarkdown(
                hit.name,
                hit.declared,
                info,
                filePath,
                report.versions,
                "",
                vulnerabilities
              );
              if (!hover) return null;
              const contents = blame
                ? [blameHoverMarkdown(blame, filePath), hover]
                : [hover];
              return { range: hit.range, contents };
            } catch (err) {
              const hover = packageVersionHoverMarkdown(
                hit.name,
                hit.declared,
                info,
                filePath,
                [],
                `Não foi possível carregar a lista de versões pela CLI selecionada. ${String(err)}`,
                vulnerabilities
              );
              if (!hover) return null;
              const contents = blame
                ? [blameHoverMarkdown(blame, filePath), hover]
                : [hover];
              return { range: hit.range, contents };
            }
          },
        });
      }
    }

    monaco.editor.defineTheme("fluent-acrylic-dark", {
      base: "vs-dark",
      inherit: true,
      // Token color rules. With `'semanticHighlighting.enabled': false` (see the
      // editor options below) these now drive the LEXICAL (Monarch) tokens — the
      // standalone theme matches each token scope (`keyword`, `keyword.if`,
      // `type`, `string`…) against these `rules`. They are also the rules that
      // WOULD color LSP semantic tokens if semantic highlighting were re-enabled
      // via the full VS Code theme path (the deferred follow-up noted below), so
      // the bare LSP type names (class, enum, method…) are kept here too.
      rules: [
        // C# Monarch emits specific scopes such as `keyword.if` and
        // `keyword.return`. Keep declarations/modifiers blue and make
        // control-flow keywords visually distinct, matching the Dark+ family.
        { token: "keyword", foreground: "569CD6" },
        { token: "keyword.if", foreground: "C586C0" },
        { token: "keyword.else", foreground: "C586C0" },
        { token: "keyword.switch", foreground: "C586C0" },
        { token: "keyword.case", foreground: "C586C0" },
        { token: "keyword.default", foreground: "C586C0" },
        { token: "keyword.for", foreground: "C586C0" },
        { token: "keyword.foreach", foreground: "C586C0" },
        { token: "keyword.while", foreground: "C586C0" },
        { token: "keyword.do", foreground: "C586C0" },
        { token: "keyword.break", foreground: "C586C0" },
        { token: "keyword.continue", foreground: "C586C0" },
        { token: "keyword.return", foreground: "C586C0" },
        { token: "keyword.throw", foreground: "C586C0" },
        { token: "keyword.try", foreground: "C586C0" },
        { token: "keyword.catch", foreground: "C586C0" },
        { token: "keyword.finally", foreground: "C586C0" },
        { token: "keyword.goto", foreground: "C586C0" },
        { token: "keyword.yield", foreground: "C586C0" },
        // Roslyn classifies flow keywords with this semantic token. It arrives
        // after Monarch's `keyword.if` / `keyword.return` token and therefore
        // must have its own rule or it falls back to the editor foreground.
        { token: "controlKeyword", foreground: "C586C0" },
        { token: "modifier", foreground: "569CD6" },
        { token: "namespace", foreground: "4EC9B0" },
        { token: "type", foreground: "4EC9B0" },
        { token: "class", foreground: "4EC9B0" },
        { token: "recordClass", foreground: "4EC9B0" },
        { token: "struct", foreground: "86C691" },
        { token: "recordStruct", foreground: "86C691" },
        { token: "interface", foreground: "B8D7A3" },
        { token: "enum", foreground: "B8D7A3" },
        { token: "delegate", foreground: "B8D7A3" },
        { token: "enumMember", foreground: "4FC1FF" },
        { token: "constant", foreground: "4FC1FF" },
        { token: "typeParameter", foreground: "4EC9B0" },
        { token: "parameter", foreground: "9CDCFE" },
        { token: "variable", foreground: "9CDCFE" },
        { token: "property", foreground: "9CDCFE" },
        { token: "field", foreground: "9CDCFE" },
        { token: "enumMember", foreground: "4FC1FF" },
        { token: "method", foreground: "DCDCAA" },
        { token: "member", foreground: "DCDCAA" },
        { token: "function", foreground: "DCDCAA" },
        { token: "extensionMethod", foreground: "DCDCAA" },
        { token: "event", foreground: "DCDCAA" },
        { token: "stringEscapeCharacter", foreground: "D7BA7D" },
        { token: "stringVerbatim", foreground: "CE9178" },
        // Roslyn uses these names when Visual Studio protocol extensions are
        // enabled. Standard LSP maps them to class/enum/etc.; keeping both makes
        // the theme resilient to either server schema.
        { token: "class name", foreground: "4EC9B0" },
        { token: "struct name", foreground: "86C691" },
        { token: "interface name", foreground: "B8D7A3" },
        { token: "enum name", foreground: "B8D7A3" },
        { token: "type parameter name", foreground: "4EC9B0" },
      ],
      // Chrome colors derive from the shared palette so the editor surfaces
      // track the CSS token layer (F2-AUD-001). Monaco needs literals at
      // registration time, so we read them from `palette` (hex without `#`
      // where Monaco expects a bare token is not required — it accepts `#rgb`).
      // Syntax-token foregrounds in `rules` above are a separate highlighting
      // concern and intentionally stay inline.
      colors: {
        "editor.background": palette.editorBg,
        "editorGutter.background": palette.editorBg,
        "editorLineNumber.foreground": palette.textMuted,
        "editorLineNumber.activeForeground": palette.textActive,
        "editor.lineHighlightBackground": "#FFFFFF0A",
        "editor.selectionBackground": "#60CDFF35",
        "editor.inactiveSelectionBackground": "#60CDFF20",
        "editorCursor.foreground": palette.accent,
        "editorIndentGuide.background1": "#FFFFFF12",
        "editorIndentGuide.activeBackground1": "#8BB7D94D",
        "minimap.background": palette.editorBg,
        "scrollbarSlider.background": "#B8C7D526",
        "scrollbarSlider.hoverBackground": "#B8C7D540",
        "scrollbarSlider.activeBackground": "#B8C7D55A",
        // Completion (IntelliSense) widget. Without these the suggest list
        // falls back to vs-dark defaults, which read as near-invisible text
        // against this theme's customized surfaces — the dropdown of
        // references becomes unreadable. Opaque surface (no acrylic alpha)
        // so the editor text never bleeds through the list.
        "editorSuggestWidget.background": palette.surfaceOverlay,
        "editorSuggestWidget.border": palette.surfaceOverlayBorder,
        "editorSuggestWidget.foreground": palette.textActive,
        "editorSuggestWidget.selectedBackground": "#2C5E80",
        "editorSuggestWidget.selectedForeground": palette.textBright,
        "editorSuggestWidget.highlightForeground": palette.accent,
        "editorSuggestWidget.focusHighlightForeground": "#9DDCFF",
        // Hover, signature-help and parameter-hint popups share the same
        // surface so all editor flyouts stay legible and consistent.
        "editorHoverWidget.background": palette.surfaceOverlay,
        "editorHoverWidget.border": palette.surfaceOverlayBorder,
        "editorHoverWidget.foreground": palette.textActive,
        "editorWidget.background": palette.surfaceOverlay,
        "editorWidget.border": palette.surfaceOverlayBorder,
        "editorWidget.foreground": palette.textActive,
        "editorCodeLens.foreground": "#93A1B5",
        // Inline (ghost text) completion preview — the dimmed italic text.
        "editorGhostText.foreground": palette.textMuted,
      },
    });
  };

  const handleMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;

    // Breakpoint toggling: click on the glyph margin (left of the line numbers).
    // The path comes from the CURRENT model uri (not the `file` prop) so the
    // handler survives tab switches without re-registration.
    editorInstance.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      const model = editorInstance.getModel();
      if (!line || !model || model.uri.scheme !== "file") return;
      debugSession.toggleBreakpoint(fromFileUri(model.uri.toString()), line);
    });
    editorInstance.onDidChangeModel(() => applyDebugDecorations());
    applyDebugDecorations();
    // v10 (#77): força a aplicação do tema custom. Na stack @codingame a prop
    // `theme` do @monaco-editor/react nem sempre aplica o tema definido em
    // beforeMount (o serviço de tema do VS Code intercepta), deixando o editor
    // no tema default claro → C# em azul/preto sobre fundo escuro = "apagado".
    // Reaplicar aqui, após o define + mount, garante o fluent-acrylic-dark.
    monaco.editor.setTheme("fluent-acrylic-dark");

    editorInstance.onDidChangeCursorPosition((e) => {
      const line = e.position.lineNumber;
      onCursorChange(line, e.position.column);

      // Update active blame highlight when cursor moves to a different line.
      if (line !== cursorLineRef.current) {
        cursorLineRef.current = line;
        publishCurrentBlame(line);
        applyBlameDecorations();
      }
    });

    const reveal = (line: number, selection?: MatchSelection) => {
      if (selection) {
        // Select the matched term so it's highlighted, then center the range.
        const range = new monaco.Range(
          line,
          selection.startColumn,
          line,
          selection.endColumn
        );
        editorInstance.setSelection(range);
        editorInstance.revealRangeInCenter(range);
      } else {
        editorInstance.revealLineInCenter(line);
        editorInstance.setPosition({ lineNumber: line, column: 1 });
      }
      editorInstance.focus();
    };

    internalReveal.current = reveal;
    if (revealRef) revealRef.current = reveal;

    const api: EditorActionsApi = {
      run: (actionId) => {
        editorInstance.getAction(actionId)?.run();
      },
      trigger: (source, handlerId, payload) => {
        editorInstance.trigger(source, handlerId, payload);
      },
      focus: () => editorInstance.focus(),
      getSelection: () => {
        const model = editorInstance.getModel();
        const sel = editorInstance.getSelection();
        if (!model || !sel || sel.isEmpty()) return null;
        const text = model.getValueInRange(sel);
        if (!text.trim()) return null;
        return {
          text,
          startLine: sel.startLineNumber,
          endLine: sel.endLineNumber,
        };
      },
    };
    internalApi.current = api;
    if (actionsRef) actionsRef.current = api;

    if (pendingReveal?.current != null) {
      reveal(pendingReveal.current.line, pendingReveal.current.selection);
      pendingReveal.current = null;
    }

    // Reload blame when the model is replaced (file switch handled by useEffect,
    // but this also catches reloads triggered by model events).
    editorInstance.onDidChangeModel(() => {
      fileAnnotationDecorationIdsRef.current = editorInstance.deltaDecorations(
        fileAnnotationDecorationIdsRef.current,
        []
      );
      diffDecorationIdsRef.current = editorInstance.deltaDecorations(
        diffDecorationIdsRef.current,
        []
      );
      dirtyDiffDecorationIdsRef.current = editorInstance.deltaDecorations(
        dirtyDiffDecorationIdsRef.current,
        []
      );
      loadBlame();
      applyDiffDecorations();
      applyPackageDecorations();
    });

    const pushMarkers = () => {
      const markers = monaco.editor.getModelMarkers({});
      onProblemsChange(
        markers.map((m) => {
          const path = fromFileUri(m.resource.toString());
          return {
            path,
            name: baseName(path),
            severity: mapSeverity(m.severity),
            message: m.message,
            line: m.startLineNumber,
            column: m.startColumn,
          };
        })
      );
    };
    monaco.editor.onDidChangeMarkers(pushMarkers);
    pushMarkers();

    // Load blame for the first file (useEffect fires before mount completes
    // on initial render, so we also trigger here for the initial file).
    if (file && gitRootPath) loadBlame();
    applyDiffDecorations();
    applyPackageDecorations();
  };

  if (!file) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-inner">
          <h2>Fluent Coder</h2>
          <p>Abra uma pasta pelo menu Arquivo (ou Ctrl+K Ctrl+O) para começar.</p>
        </div>
      </div>
    );
  }

  // Hold the editor back until the @codingame services are initialized. Without
  // this the first <Editor> could call monaco.editor.create() before
  // initialize() resolves (which the v10 stack forbids) or against the CDN
  // Monaco (breaking the single-instance contract → empty getModels(), no LSP).
  if (monacoError) {
    // Boot failed — show the reason instead of an endless spinner so the user
    // (and a screen reader, via role="alert") knows the editor won't appear.
    return (
      <div className="editor-empty">
        <div className="editor-empty-inner" role="alert">
          <p>Falha ao carregar o editor.</p>
          <p>{monacoError instanceof Error ? monacoError.message : String(monacoError)}</p>
        </div>
      </div>
    );
  }
  if (!monacoReady) {
    return (
      <div className="editor-empty">
        {/* role="status" + aria-live so a screen reader announces the loading
            state (and its resolution) instead of leaving AT users in silence. */}
        <div className="editor-empty-inner" role="status" aria-live="polite">
          <p>Carregando editor…</p>
        </div>
      </div>
    );
  }

  // Untitled buffers have no on-disk path; use their synthetic `untitled:` URI
  // directly so Monaco doesn't mangle it through `file://` (LSP/blame stay off —
  // they're plaintext until saved).
  const modelPath = file.path.startsWith("untitled:") || file.path.startsWith("fluentcoder://")
    ? file.path
    : toFileUri(file.path);

  if (file.mode === "diff") {
    const sourcePath = file.sourcePath ?? file.path;
    const diffLanguage = languageForFile(baseName(sourcePath), sourcePath);
    const originalModelPath = `${modelPath}:original`;
    const modifiedModelPath = `${modelPath}:modified`;
    return (
      <div className="editor-diff-shell">
        <div className="editor-diff-header" role="status">
          <div className="editor-diff-title">
            <span className="codicon codicon-diff" aria-hidden="true" />
            <span>{file.sourceLabel ?? "Comparação Git"}</span>
          </div>
          <div className="editor-diff-labels" aria-hidden="true">
            <span>{file.originalLabel ?? "Antes"}</span>
            <span>{file.modifiedLabel ?? "Depois"}</span>
          </div>
        </div>
        <DiffEditor
          height="100%"
          theme="fluent-acrylic-dark"
          language={diffLanguage}
          originalLanguage={diffLanguage}
          modifiedLanguage={diffLanguage}
          original={file.originalContent ?? ""}
          modified={file.modifiedContent ?? file.content}
          originalModelPath={originalModelPath}
          modifiedModelPath={modifiedModelPath}
          beforeMount={handleBeforeMount}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            enableSplitViewResizing: true,
            renderIndicators: true,
            glyphMargin: true,
            lineDecorationsWidth: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontSize: 14,
            padding: { top: 12 },
            diffWordWrap: "off",
            ignoreTrimWhitespace: false,
            renderOverviewRuler: true,
          }}
        />
      </div>
    );
  }

  const packageState =
    file && isPackageManifest(file.path)
      ? inlineStateForPackageJson(file.path)
      : null;
  const packageAuditState =
    file && isPackageManifest(file.path)
      ? inlineAuditStateForPackageJson(file.path)
      : null;
  const packageOutdatedCount =
    packageState?.status === "ready" ? packageState.outdated.size : 0;
  const packageSecurityCount =
    packageAuditState?.status === "ready" ? packageAuditState.summary.total : 0;
  const packageManagers =
    packageState && "managers" in packageState && packageState.managers
      ? packageState.managers
      : packageState?.status === "ready" || packageState?.status === "checking" || packageState?.status === "unsupported"
        ? packageState.manager
          ? [packageState.manager]
          : []
        : [];
  const selectedPackageManager =
    packageState?.status === "ready" || packageState?.status === "checking" || packageState?.status === "unsupported" || packageState?.status === "error"
      ? packageState.manager ?? ""
      : "";
  const editorLanguage = isDiffViewFile(file)
    ? "diff"
    : languageForFile(
        file.sourcePath ? baseName(file.sourcePath) : file.name,
        file.sourcePath ?? file.path
      );
  const editor = (
    <Editor
      height="100%"
      theme="fluent-acrylic-dark"
      // The model URI must use the `file://` scheme so LSP clients whose
      // documentSelector is `{ scheme: "file" }` attach to it. Passing the raw
      // Windows path would make Monaco treat the drive letter as the URI scheme.
      path={modelPath}
      // KEEP the model alive across tab switches. By default @monaco-editor/react
      // DISPOSES the previous model when `path` changes (switching tabs), which
      // fires Monaco's `onWillDisposeModel` → the Razor broker's `forgetDoc`
      // (clears the `.cshtml` diagnostics + drops the source map) and forces a
      // slow, race-prone re-prepare on return. That made the C# projection error
      // (and Roslyn diagnostics in general) vanish after visiting another file and
      // coming back. With the model kept, switching tabs no longer tears the LSP
      // document down; the real dispose happens only when the tab is truly closed
      // (App's open-paths reconciliation effect, guarded against split groups).
      keepCurrentModel
      language={editorLanguage}
      value={file.content}
      onChange={(value) => {
        if (!file.readOnly) onChange(value ?? "");
      }}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      options={{
        fontSize: 14,
        readOnly: Boolean(file.readOnly),
        readOnlyMessage: { value: file.sourceLabel ?? "Esta revisão é somente leitura." },
        codeLens: true,
        codeLensFontSize: 12,
        codeLensFontFamily: "Segoe UI Variable, Segoe UI, sans-serif",
        lineDecorationsWidth: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        // Debugger gutter: explicit so breakpoint glyphs always have a lane.
        glyphMargin: true,
        // Indentation: keep Monaco's smartest auto-indent on, detect the file's
        // own tabs/spaces, and let the language server format on type/paste so
        // code stays properly indented (VSCode-like) across languages.
        autoIndent: "full",
        detectIndentation: true,
        formatOnType: true,
        formatOnPaste: true,
        padding: { top: 12 },
        mouseWheelZoom: true,
        // Suggest (IntelliSense) widget sizing. Monaco derives each row's
        // height from `suggestLineHeight` or, when 0, the editor's computed
        // `fontInfo.lineHeight`. Pinning both font size and line height keeps
        // the virtual list rows tall enough for the label + 22px type icon, so
        // entries don't overlap into an unreadable, doubled list.
        suggestFontSize: 13,
        suggestLineHeight: 22,
        // Desliga as sugestões baseadas em palavras do documento (os itens com
        // ícone `abc`). Na stack @codingame/v10 elas vêm LIGADAS por default e
        // poluíam o autocomplete do `.cshtml`: ao digitar `@Model` apareciam
        // palavras soltas do arquivo em vez (ou antes) dos membros C# do Roslyn,
        // e enquanto a completion da projeção (mais lenta) ainda não respondia,
        // só o lixo `abc` aparecia. Com isso off, só os providers reais
        // (Roslyn via projeção + HTML) preenchem o widget.
        wordBasedSuggestions: "off",
        // Semantic highlighting NATIVO desligado na stack monaco-languageclient
        // v10. Motivo (comprovado por experimento — ver docs/migration): a stack
        // `@codingame/monaco-vscode-api` resolve as cores de semantic tokens
        // pelo serviço de tema do VS Code (que exige theme/textmate
        // service-overrides + `semanticTokenColors`), NÃO pelas `rules` do
        // `defineTheme` standalone. Com o flag ligado, os semantic tokens do
        // Roslyn sobrescreviam a camada Monarch e ficavam SEM cor — deixando o
        // C# inteiro apagado. O Monarch (`csharpMonarch` em monacoSetup.ts)
        // colore o léxico via `rules` do tema, e a classificação semântica fina
        // do Roslyn (class vs struct vs enum, método vs variável) é aplicada
        // por DECORATIONS pelo bridge de semantic tokens — ver
        // src/lsp/semanticColorizer.ts. Este flag deve permanecer false: ligar
        // o engine nativo reintroduziria a camada sem cor POR CIMA de tudo.
        "semanticHighlighting.enabled": false,
      }}
    />
  );
  const supportsGitAnnotations = Boolean(
    gitRootPath &&
      file &&
      !file.path.startsWith("untitled:") &&
      !file.readOnly &&
      !isDiffViewFile(file)
  );
  const showGitAnnotationsToolbar = Boolean(
    gitRootPath && file && !file.readOnly && !isDiffViewFile(file)
  );
  const gitAnnotationsUnavailable =
    supportsGitAnnotations && !hasGitFileAnnotations && gitFileAnnotationMode !== "off";
  const editorFrame = (
    <div className="editor-pane-shell">
      {file.readOnly && (
        <div className="editor-readonly-banner" role="status">
          <div className="editor-readonly-main">
            <span className="codicon codicon-lock" aria-hidden="true" />
            <span>{file.sourceLabel ?? "Revisão Git somente leitura"}</span>
          </div>
          {file.sourcePath && file.revisionHash && (
            <div className="editor-readonly-actions" aria-label="Ações da revisão Git">
              <button
                type="button"
                title="Abrir histórico do arquivo"
                onClick={() => onShowFileHistory?.(file.sourcePath!)}
              >
                <span className="codicon codicon-history" aria-hidden="true" />
                Histórico
              </button>
              <button
                type="button"
                title="Abrir alterações desta revisão"
                onClick={() =>
                  onOpenRevisionDiff?.(
                    file.sourcePath!,
                    file.revisionHash!,
                    file.revisionShort ?? file.revisionHash!.slice(0, 7),
                    "previous"
                  )
                }
              >
                <span className="codicon codicon-diff" aria-hidden="true" />
                Alterações
              </button>
              <button
                type="button"
                title="Comparar esta revisão com o arquivo atual"
                onClick={() =>
                  onOpenRevisionDiff?.(
                    file.sourcePath!,
                    file.revisionHash!,
                    file.revisionShort ?? file.revisionHash!.slice(0, 7),
                    "working"
                  )
                }
              >
                <span className="codicon codicon-diff-multiple" aria-hidden="true" />
                Working
              </button>
              <button
                type="button"
                disabled={!file.revisionRemoteUrl}
                title={
                  file.revisionRemoteUrl
                    ? "Abrir commit remoto"
                    : "Sem remoto para esta revisão"
                }
                onClick={() =>
                  file.revisionRemoteUrl &&
                  window.open(file.revisionRemoteUrl, "_blank", "noopener,noreferrer")
                }
              >
                <span className="codicon codicon-link-external" aria-hidden="true" />
                Remoto
              </button>
            </div>
          )}
        </div>
      )}
      {showGitAnnotationsToolbar && (
        <div
          className={`git-file-annotations-toolbar ${
            gitAnnotationsUnavailable ? "is-unavailable" : ""
          }`}
          aria-label="Anotações Git do arquivo"
          role="group"
        >
          <span className="git-file-annotations-label">Git</span>
          <div className="git-file-annotations-segment" role="radiogroup">
            {(["off", "blame", "heatmap"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                className={`git-file-annotation-button ${
                  gitFileAnnotationMode === mode ? "active" : ""
                }`}
                aria-checked={gitFileAnnotationMode === mode}
                aria-pressed={gitFileAnnotationMode === mode}
                disabled={!supportsGitAnnotations && mode !== "off"}
                title={
                  mode === "off"
                    ? "Ocultar anotações Git do arquivo"
                    : mode === "blame"
                      ? "Mostrar autoria por linha na gutter"
                      : "Mostrar heatmap de recência por linha"
                }
                onClick={() => setGitFileAnnotationMode(mode)}
              >
                {mode === "off" ? "Off" : mode === "blame" ? "Blame" : "Heatmap"}
              </button>
            ))}
          </div>
        </div>
      )}
      {editor}
    </div>
  );
  if (!packageState) return editorFrame;

  return (
    <div className="package-editor-shell">
      <div className="package-editor-toolbar" aria-label="Ações de dependências">
        <span
          className={`package-editor-status status-${
            packageState.status === "ready" &&
            (packageOutdatedCount > 0 || packageSecurityCount > 0)
              ? "outdated"
              : packageState.status
          }`}
          title={packageState.status === "error" ? packageState.message : undefined}
        >
          {packageInlineSummary(packageState, packageAuditState ?? undefined)}
        </span>
        {packageManagers.length > 1 && (
          <select
            className="package-editor-manager"
            value={selectedPackageManager}
            disabled={!packageRootPath || packageState.status === "checking"}
            title="Gerenciador usado para versões e audit deste package.json"
            onChange={(event) => {
              if (!packageRootPath || !file) return;
              const manager = event.target.value as PackageManager;
              setSelectedPackageManager(file.path, manager);
              void recheckPackageJsonIntel(file.path, { force: true, audit: true });
            }}
          >
            {packageState.status === "needsSelection" && (
              <option value="" disabled>
                Escolha CLI…
              </option>
            )}
            {packageManagers.map((manager) => (
              <option key={manager} value={manager}>
                {manager}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="package-editor-action"
          disabled={!packageRootPath || packageState.status === "checking"}
          title="Atualiza versões e audit de segurança usando a CLI principal deste package.json"
          onClick={() => {
            if (packageRootPath && file) {
              void recheckPackageJsonIntel(file.path, { force: true, audit: true });
            }
          }}
        >
          Reverificar tudo
        </button>
        {packageAuditState && (
          <>
            <button
              type="button"
              className={`package-editor-action audit-${
                packageAuditState.status === "ready"
                  ? auditSeverityClass(packageAuditState.summary)
                  : packageAuditState.status
              }`}
              disabled={!packageRootPath || packageAuditState.status === "checking"}
              title={
                packageAuditState.status === "error"
                  ? packageAuditState.message
                  : "Executa audit de segurança com o gerenciador selecionado"
              }
              onClick={() => {
                if (packageRootPath && file) {
                  void ensurePackageAuditCheck(packageRootPath, file.path, {
                    force: true,
                    connId: packageConnId,
                  });
                }
              }}
            >
              {auditSummaryLabel(packageAuditState)}
            </button>
          </>
        )}
        <button
          type="button"
          className="package-editor-action primary"
          disabled={packageState.status !== "ready" || packageOutdatedCount === 0}
          title="Aplica a versão compatível/recomendada pela CLI no buffer aberto. Revise antes de salvar."
          onClick={() => {
            if (!file) return;
            const result = applyRecommendedPackageVersions(file.content, packageState, "wanted");
            if (result.changed > 0) onChange(result.content);
          }}
        >
          Fixar compatíveis
        </button>
        <button
          type="button"
          className="package-editor-action danger"
          disabled={packageState.status !== "ready" || packageOutdatedCount === 0}
          title="Aplica latest no buffer aberto. Pode atravessar major version; revise antes de salvar."
          onClick={() => {
            if (!file) return;
            const result = applyRecommendedPackageVersions(file.content, packageState, "latest");
            if (result.changed > 0) onChange(result.content);
          }}
        >
          Fixar latest
        </button>
      </div>
      <div className="package-editor-monaco">{editorFrame}</div>
    </div>
  );
}
