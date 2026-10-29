/**
 * Resolve os anexos de um envio em blocos de texto para o prompt: lê
 * arquivos, consulta o grafo de conhecimento (`build_context_bundle` e o
 * índice de conhecimento em cache), diagnósticos e a saída do terminal.
 * Falhas viram um bloco explicativo — um anexo quebrado nunca impede o envio.
 */
import { buildContextBundle, readFile } from "../api";
import { relativeToWorkspace } from "../agents/store";
import type { AgentEditorContext } from "../agents/types";
import { loadIndex } from "../knowledge/knowledgeCache";
import type { Problem } from "../types";
import {
  capBlockText,
  fenceLanguage,
  formatFileBlock,
  formatGraphBlock,
  formatProblemsBlock,
  formatSelectionBlock,
  formatTerminalBlock,
  type ChatAttachment,
} from "./context";
import { recentTerminalOutput } from "./terminalTap";
import { formatWorkspaceContext, knowledgeHubs, rankKnowledge } from "./workspaceSearch";

export interface ResolveDeps {
  workspacePath: string;
  message: string;
  editor: AgentEditorContext | null;
  readProblems: () => Problem[];
}

const TOP_CONTENT_CAP = 6_000;

async function topContents(workspacePath: string, paths: string[]) {
  const out: { rel: string; content: string; lang: string }[] = [];
  for (const path of paths) {
    try {
      const file = await readFile(path);
      const rel = relativeToWorkspace(workspacePath, path);
      out.push({
        rel,
        content: capBlockText(file.content, TOP_CONTENT_CAP),
        lang: fenceLanguage(rel.split("/").pop() ?? rel),
      });
    } catch {
      // Arquivo ilegível (binário, removido): só a listagem basta.
    }
  }
  return out;
}

async function resolveOne(attachment: ChatAttachment, deps: ResolveDeps): Promise<string> {
  const { workspacePath, message, editor } = deps;
  switch (attachment.kind) {
    case "file": {
      const file = await readFile(attachment.path);
      return formatFileBlock(workspacePath, attachment.path, file.content);
    }
    case "selection":
      return formatSelectionBlock(workspacePath, attachment.context);
    case "problems":
      return formatProblemsBlock(workspacePath, deps.readProblems());
    case "terminal":
      return formatTerminalBlock(recentTerminalOutput());
    case "graph": {
      const bundle = await buildContextBundle(workspacePath, attachment.path, 1);
      return formatGraphBlock(bundle);
    }
    case "context": {
      const index = await loadIndex(workspacePath);
      const ranked = rankKnowledge(index, message, { seedPath: editor?.path ?? null, limit: 8 });
      const contents = await topContents(
        workspacePath,
        ranked.slice(0, 2).map((entry) => entry.file.path),
      );
      return formatWorkspaceContext("CONTEXTO RELEVANTE (#contexto)", ranked, index, { contents });
    }
    case "workspace": {
      const index = await loadIndex(workspacePath);
      const ranked = rankKnowledge(index, message, { seedPath: editor?.path ?? null, limit: 15 });
      const contents = await topContents(
        workspacePath,
        ranked.slice(0, 1).map((entry) => entry.file.path),
      );
      return formatWorkspaceContext("CONTEXTO DO WORKSPACE (@workspace)", ranked, index, {
        hubs: knowledgeHubs(index, 8),
        contents,
      });
    }
  }
}

export async function resolveAttachmentBlocks(
  attachments: ChatAttachment[],
  deps: ResolveDeps,
): Promise<string[]> {
  return Promise.all(
    attachments.map((attachment) =>
      resolveOne(attachment, deps).catch(
        (error) =>
          `CONTEXTO INDISPONÍVEL (${attachment.kind})\nNão foi possível obter este contexto: ${String(error)}`,
      ),
    ),
  );
}
