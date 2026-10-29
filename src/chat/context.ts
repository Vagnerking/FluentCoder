/**
 * Anexos de contexto do Fluent Chat (chips do composer) e a montagem do
 * prompt enviado ao provedor.
 *
 * Contrato (docs/context/agentes-ia.md): o contexto é ORIGINADO DO USUÁRIO —
 * só entra o que ele anexou (chip/menção) ou o que o agente personalizado dele
 * define como preset. Os blocos vão no prompt enviado, nunca na `content`
 * exibida, no mesmo formato do bloco `CONTEXTO DO EDITOR`.
 */
import { formatEditorContextReference, relativeToWorkspace } from "../agents/store.ts";
import type { AgentEditorContext, ContextPreset } from "../agents/types.ts";
import type { Problem } from "../types.ts";
import { mentionDefinition, type MentionKind } from "./mentions.ts";

export type ChatAttachment =
  | { id: string; kind: "file"; path: string; name: string }
  | { id: string; kind: "selection"; context: AgentEditorContext }
  | { id: string; kind: "graph"; path: string; name: string }
  | { id: string; kind: "problems" }
  | { id: string; kind: "context" }
  | { id: string; kind: "terminal" }
  | { id: string; kind: "workspace" };

export type ChatAttachmentKind = ChatAttachment["kind"];

/** Rótulo curto da chip. */
export function attachmentLabel(attachment: ChatAttachment): string {
  switch (attachment.kind) {
    case "file":
      return attachment.name;
    case "graph":
      return `grafo: ${attachment.name}`;
    case "selection": {
      const { context } = attachment;
      if (context.startLine == null || context.endLine == null) return context.name;
      return context.startLine === context.endLine
        ? `${context.name}:${context.startLine}`
        : `${context.name}:${context.startLine}-${context.endLine}`;
    }
    case "problems":
      return "#problemas";
    case "context":
      return "#contexto";
    case "terminal":
      return "#terminal";
    case "workspace":
      return "@workspace";
  }
}

/** IconAction da chip. */
export function attachmentIcon(attachment: ChatAttachment): string {
  switch (attachment.kind) {
    case "file":
      return "file";
    case "selection":
      return "selection";
    default:
      return mentionDefinition(attachment.kind as MentionKind).icon;
  }
}

/** Chave de deduplicação (o mesmo contexto não entra duas vezes). */
export function attachmentKey(attachment: ChatAttachment): string {
  switch (attachment.kind) {
    case "file":
    case "graph":
      return `${attachment.kind}:${attachment.path}`;
    case "selection":
      return `selection:${attachment.context.path}:${attachment.context.startLine}-${attachment.context.endLine}`;
    default:
      return attachment.kind;
  }
}

export function addAttachment(list: ChatAttachment[], attachment: ChatAttachment): ChatAttachment[] {
  const key = attachmentKey(attachment);
  return list.some((item) => attachmentKey(item) === key) ? list : [...list, attachment];
}

/** Presets do agente personalizado → anexos (resolvidos no envio). */
export function presetAttachments(
  presets: ContextPreset[] | undefined,
  editor: AgentEditorContext | null,
  makeId: () => string,
): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const preset of presets ?? []) {
    switch (preset) {
      case "graph":
        if (editor) out.push({ id: makeId(), kind: "graph", path: editor.path, name: editor.name });
        break;
      case "selection":
        if (editor?.selectionText) out.push({ id: makeId(), kind: "selection", context: editor });
        break;
      case "context":
      case "workspace":
      case "problems":
        out.push({ id: makeId(), kind: preset });
        break;
    }
  }
  return out;
}

const FILE_CAP = 12_000;
const BUNDLE_CAP = 30_000;
const TERMINAL_CAP = 8_000;
const MAX_PROBLEMS = 60;

export function capBlockText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncado em ${max.toLocaleString("pt-BR")} caracteres)`;
}

/** Linguagem do code fence pelo nome do arquivo (rótulo para o modelo). */
export function fenceLanguage(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", rs: "rust", py: "python",
    cs: "csharp", cshtml: "razor", razor: "razor", json: "json", md: "markdown", css: "css",
    scss: "scss", html: "html", xml: "xml", yml: "yaml", yaml: "yaml", toml: "toml",
    sh: "bash", ps1: "powershell", sql: "sql", go: "go", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  };
  return map[ext] ?? "";
}

export function formatFileBlock(workspacePath: string, path: string, content: string): string {
  const rel = relativeToWorkspace(workspacePath, path);
  const name = rel.split("/").pop() ?? rel;
  return [
    `ARQUIVO ANEXADO: \`${rel}\``,
    `\`\`\`${fenceLanguage(name)}`,
    capBlockText(content, FILE_CAP),
    "```",
  ].join("\n");
}

export function formatSelectionBlock(workspacePath: string, context: AgentEditorContext): string {
  return formatEditorContextReference(workspacePath, context);
}

const SEVERITY_LABEL: Record<Problem["severity"], string> = {
  error: "erro",
  warning: "aviso",
  info: "info",
};

export function formatProblemsBlock(workspacePath: string, problems: Problem[]): string {
  if (problems.length === 0) return "PROBLEMAS DO WORKSPACE\nNenhum erro ou aviso no momento.";
  const order: Record<Problem["severity"], number> = { error: 0, warning: 1, info: 2 };
  const sorted = [...problems].sort((a, b) => order[a.severity] - order[b.severity]);
  const lines = sorted
    .slice(0, MAX_PROBLEMS)
    .map(
      (problem) =>
        `- \`${relativeToWorkspace(workspacePath, problem.path)}:${problem.line}:${problem.column}\` [${SEVERITY_LABEL[problem.severity]}] ${problem.message}`,
    );
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const header = `PROBLEMAS DO WORKSPACE (${errors} erro(s), ${problems.length - errors} outro(s))`;
  const more = problems.length > MAX_PROBLEMS ? [`…e mais ${problems.length - MAX_PROBLEMS}.`] : [];
  return [header, ...lines, ...more].join("\n");
}

export function formatGraphBlock(bundle: string): string {
  return `GRAFO DE CONHECIMENTO (arquivo + vizinhos)\n${capBlockText(bundle, BUNDLE_CAP)}`;
}

export function formatTerminalBlock(output: string): string {
  const text = output.trim();
  if (!text) return "SAÍDA DO TERMINAL\n(o terminal integrado ainda não produziu saída)";
  const tail = text.length > TERMINAL_CAP ? `…${text.slice(-TERMINAL_CAP)}` : text;
  return ["SAÍDA DO TERMINAL (mais recente)", "```", tail, "```"].join("\n");
}

/**
 * Prompt final de um envio: os blocos de contexto + a mensagem. Sem blocos, a
 * mensagem vai crua (nenhum scaffolding de aplicativo).
 */
export function assemblePrompt(message: string, blocks: string[]): string {
  const context = blocks.map((block) => block.trim()).filter(Boolean);
  if (context.length === 0) return message;
  return `${context.join("\n\n")}\n\nMENSAGEM DO USUÁRIO\n${message}`;
}
