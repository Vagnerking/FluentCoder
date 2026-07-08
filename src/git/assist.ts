import type { GitCommit, GitFileStatus } from "../types";

export type GitAssistKind = "commitMessage" | "branchName";

export interface GitAssistInstructionSet {
  /** Future settings hook: user/team rules for commit subjects and branch names. */
  commitMessage?: string;
  /** Future settings hook: user/team rules for branch naming. */
  branchName?: string;
}

export interface GitAssistPreferences {
  /**
   * Future settings hook. Defaults keep the assistant conservative today, and
   * the settings UI can later replace/extend them without changing GitPanel.
   */
  instructions?: GitAssistInstructionSet;
  /** Whether the assistant should infer style from the repository history. */
  inferStyleFromHistory?: boolean;
  /** Upper bounds used in prompts so the agent stays quick and focused. */
  maxFiles?: number;
  maxRecentCommits?: number;
}

export const DEFAULT_GIT_ASSIST_PREFERENCES: Required<GitAssistPreferences> = {
  inferStyleFromHistory: true,
  maxFiles: 40,
  maxRecentCommits: 12,
  instructions: {
    commitMessage: [
      "Siga o padrão dominante dos commits recentes do repositório.",
      "Se o histórico usa Conventional Commits, mantenha o mesmo prefixo e escopo quando fizer sentido.",
      "Use português ou inglês conforme o idioma predominante dos commits recentes.",
      "Descreva a intenção da mudança, não apenas o arquivo alterado.",
    ].join("\n"),
    branchName: [
      "Siga o padrão dominante das branches/commits recentes quando ele estiver claro.",
      "Use prefixos semânticos curtos como feat/, fix/, chore/ ou docs/ quando fizer sentido.",
      "Use apenas caracteres seguros para Git e mantenha o nome curto.",
    ].join("\n"),
  },
};

export interface GitAssistRequest {
  kind: GitAssistKind;
  repoName: string;
  rootPath: string;
  branch: string;
  provider: "local" | "ssh";
  files: GitFileStatus[];
  recentCommits: GitCommit[];
  fallback: string;
  preferences?: GitAssistPreferences;
}

export interface GitAssistAdapter {
  (request: GitAssistRequest): Promise<string | null>;
}

export interface GitAssistResult {
  value: string;
  source: "agent" | "heuristic";
}

function fileSummary(file: GitFileStatus): string {
  const state = file.conflicted
    ? "conflict"
    : file.staged
      ? "staged"
      : file.untracked
        ? "untracked"
        : "changed";
  return `${file.code.trim() || "M"} ${state} ${file.path}`;
}

function normalizeCommitMessage(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^["'`]+|["'`]+$/g, "")
    .slice(0, 120)
    .trim() ?? "";
}

function normalizeBranchName(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/(^[./-]+)|([./-]+$)/g, "")
    .slice(0, 80)
    .toLowerCase() ?? "";
}

export function normalizeGitAssistValue(kind: GitAssistKind, value: string): string {
  return kind === "branchName"
    ? normalizeBranchName(value)
    : normalizeCommitMessage(value);
}

export function buildGitAssistPrompt(request: GitAssistRequest): string {
  const preferences = {
    ...DEFAULT_GIT_ASSIST_PREFERENCES,
    ...request.preferences,
    instructions: {
      ...DEFAULT_GIT_ASSIST_PREFERENCES.instructions,
      ...request.preferences?.instructions,
    },
  };
  const recent = request.recentCommits.slice(0, preferences.maxRecentCommits);
  const files = request.files.slice(0, preferences.maxFiles);
  const customInstructions =
    request.kind === "branchName"
      ? preferences.instructions.branchName
      : preferences.instructions.commitMessage;
  const task =
    request.kind === "branchName"
      ? [
          "Gere apenas um nome de branch Git.",
          "Use um padrão curto, em kebab-case, com prefixo semântico quando fizer sentido.",
          "Não use markdown, explicação, aspas nem múltiplas opções.",
        ]
      : [
          "Gere apenas uma mensagem de commit em uma linha.",
          preferences.inferStyleFromHistory
            ? "Imite o padrão dos commits recentes quando houver um padrão claro."
            : "Não tente inferir estilo do histórico quando ele conflitar com as instruções configuradas.",
          "Prefira Conventional Commits se o histórico já usa esse estilo.",
          "Não use markdown, explicação, aspas nem corpo de commit.",
        ];

  return [
    "Você é o assistente de Git do Fluent Coder.",
    ...task,
    customInstructions ? `Instruções do usuário/equipe:\n${customInstructions}` : "",
    "",
    `Repositório: ${request.repoName}`,
    `Branch atual: ${request.branch || "sem branch"}`,
    `Origem: ${request.provider === "ssh" ? "SSH/remoto" : "local"}`,
    "",
    "Arquivos alterados:",
    files.length > 0 ? files.map((file) => `- ${fileSummary(file)}`).join("\n") : "- Nenhum arquivo alterado",
    "",
    "Commits recentes:",
    recent.length > 0
      ? recent.map((commit) => `- ${commit.subject}`).join("\n")
      : "- Nenhum commit recente disponível",
    "",
    `Fallback atual: ${request.fallback}`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export async function suggestWithGitAssistant(
  request: GitAssistRequest,
  adapter?: GitAssistAdapter
): Promise<GitAssistResult> {
  if (adapter) {
    try {
      const assisted = await adapter(request);
      const normalized = assisted ? normalizeGitAssistValue(request.kind, assisted) : "";
      if (normalized) return { value: normalized, source: "agent" };
    } catch {
      // Keep Git actions responsive. The panel already has a deterministic fallback.
    }
  }
  return { value: request.fallback, source: "heuristic" };
}
