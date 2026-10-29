import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { editor, IMarkdownString } from "monaco-editor";
import { gitBlame } from "../../api";
import type { BlameHunk, GitAnnotationMode } from "../../types";
import { buildFileAnnotationSpecs } from "./gitAnnotations";

function normalizeKeyPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Blame por arquivo, compartilhado com os providers globais de hover. */
const blameCacheByFile = new Map<string, Map<number, BlameHunk>>();

export function gitBlameCacheKey(filePath: string, root?: string | null, connId?: string): string {
  return `${connId ?? "local"}::${normalizeKeyPath(root ?? "")}::${normalizeKeyPath(filePath)}`;
}

export function cachedBlameForLine(
  filePath: string,
  line: number,
  root?: string | null,
  connId?: string
): BlameHunk | undefined {
  return blameCacheByFile.get(gitBlameCacheKey(filePath, root, connId))?.get(line);
}

export function forgetCachedBlame(filePath: string, root?: string | null, connId?: string): void {
  blameCacheByFile.delete(gitBlameCacheKey(filePath, root, connId));
}

export interface UseGitAnnotationsOptions {
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>;
  monacoRef: MutableRefObject<typeof import("monaco-editor") | null>;
  /** Arquivo real (não untitled/diff/revisão) ou null quando não há blame. */
  filePath: string | null;
  gitRootPath: string | null | undefined;
  gitConnId?: string;
  /** Modo de anotação do editor (toggle explícito; padrão "off"). */
  mode: GitAnnotationMode;
  hoverFor: (hunk: BlameHunk) => IMarkdownString;
  /** Blame carregado (para blame inline da linha do cursor / status bar). */
  onLoaded?: () => void;
  /** Sem blame (arquivo fora do Git, não rastreado ou erro). */
  onFailed?: () => void;
}

/**
 * Carregamento de blame + decorações de anotação de arquivo (autoria por linha
 * e mapa de recência). Extraído do EditorPane: as funções retornadas são
 * estáveis e sempre leem as opções mais recentes (podem ser chamadas de
 * callbacks registrados no mount do Monaco sem ficarem obsoletas).
 */
export function useGitAnnotations(options: UseGitAnnotationsOptions) {
  const opts = useRef(options);
  opts.current = options;
  const blameRef = useRef<Map<number, BlameHunk>>(new Map());
  const decorationIds = useRef<string[]>([]);
  // Blame carregado para QUAL arquivo: evita reportar o estado do arquivo
  // anterior durante a troca de aba.
  const [blameFor, setBlameFor] = useState<string | null>(null);
  const hasBlame = blameFor !== null && blameFor === options.filePath;
  // Descarta respostas de blame de um arquivo anterior.
  const requestSeq = useRef(0);

  const clearDecorations = useCallback(() => {
    decorationIds.current =
      opts.current.editorRef.current?.deltaDecorations(decorationIds.current, []) ?? [];
  }, []);

  const applyDecorations = useCallback(() => {
    const { editorRef, monacoRef, mode, hoverFor } = opts.current;
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !monaco || !model) {
      clearDecorations();
      return;
    }
    const specs = buildFileAnnotationSpecs(blameRef.current, model.getLineCount(), mode);
    decorationIds.current = ed.deltaDecorations(
      decorationIds.current,
      specs.map((spec) => ({
        range: new monaco.Range(spec.line, 1, spec.line, 1),
        options: {
          linesDecorationsClassName: spec.className,
          overviewRuler: {
            color: spec.overviewColor,
            position: monaco.editor.OverviewRulerLane.Right,
          },
          hoverMessage: hoverFor(spec.hunk),
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }))
    );
  }, [clearDecorations]);

  /** Zera o blame (troca de arquivo) sem disparar nova carga. */
  const reset = useCallback(() => {
    requestSeq.current++;
    blameRef.current = new Map();
    setBlameFor(null);
    clearDecorations();
    const { filePath, gitRootPath, gitConnId } = opts.current;
    if (filePath && gitRootPath) forgetCachedBlame(filePath, gitRootPath, gitConnId);
  }, [clearDecorations]);

  const loadBlame = useCallback(async () => {
    const { editorRef, filePath, gitRootPath, gitConnId } = opts.current;
    if (!editorRef.current || !gitRootPath || !filePath) return;
    if (filePath.startsWith("untitled:")) return;
    const seq = ++requestSeq.current;
    try {
      const hunks = await gitBlame(gitRootPath, filePath, gitConnId);
      if (seq !== requestSeq.current) return;
      const map = new Map<number, BlameHunk>();
      hunks.forEach((h) => map.set(h.line, h));
      blameRef.current = map;
      setBlameFor(map.size > 0 ? filePath : null);
      blameCacheByFile.set(gitBlameCacheKey(filePath, gitRootPath, gitConnId), map);
      opts.current.onLoaded?.();
      applyDecorations();
    } catch {
      if (seq !== requestSeq.current) return;
      // Fora de um repositório ou arquivo não rastreado: sem blame, em silêncio.
      blameRef.current = new Map();
      setBlameFor(null);
      forgetCachedBlame(filePath, gitRootPath, gitConnId);
      opts.current.onFailed?.();
      clearDecorations();
    }
  }, [applyDecorations, clearDecorations]);

  // Toggle de modo (ou troca de arquivo) reaplica as decorações.
  useEffect(() => {
    applyDecorations();
  }, [options.mode, options.filePath, hasBlame, applyDecorations]);

  return { blameRef, hasBlame, loadBlame, reset, applyDecorations, clearDecorations };
}
