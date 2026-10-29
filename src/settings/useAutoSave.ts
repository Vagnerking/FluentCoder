/**
 * `files.autoSave` (como no VS Code):
 * - `afterDelay`: salva os arquivos modificados `files.autoSaveDelay` ms
 *   depois da última edição;
 * - `onFocusChange`: salva o editor que perdeu o foco (troca de aba/grupo);
 * - `onWindowChange`: salva tudo ao sair da janela.
 *
 * Só arquivos reais (sem untitled, somente leitura ou abas virtuais). Erros
 * de salvamento já são reportados pelo `saveFile` do App; aqui são engolidos
 * para o auto-save nunca derrubar nada.
 */
import { useEffect, useRef } from "react";
import { useSetting } from "./react.ts";

export interface AutoSaveFile {
  path: string;
  dirty: boolean;
  readOnly?: boolean;
  content: string;
}

export function autoSaveCandidates<T extends AutoSaveFile>(files: readonly T[], isVirtual: (path: string) => boolean): T[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    if (!f.dirty || f.readOnly || isVirtual(f.path) || f.path.startsWith("untitled:") || seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}

export function useAutoSave<T extends AutoSaveFile>(
  files: readonly T[],
  activePath: string | null,
  isVirtual: (path: string) => boolean,
  save: (file: T) => Promise<unknown>,
): void {
  const mode = useSetting<string>("files.autoSave");
  const delay = useSetting<number>("files.autoSaveDelay");
  const latest = useRef({ files, isVirtual, save });
  latest.current = { files, isVirtual, save };
  const saving = useRef(new Set<string>());

  const saveAll = (filter?: (f: T) => boolean) => {
    const { files: fs, isVirtual: virt, save: sv } = latest.current;
    for (const f of autoSaveCandidates(fs, virt)) {
      if (filter && !filter(f)) continue;
      if (saving.current.has(f.path)) continue;
      saving.current.add(f.path);
      void sv(f)
        .catch(() => {})
        .finally(() => saving.current.delete(f.path));
    }
  };

  // afterDelay: reinicia o timer a cada mudança de conteúdo.
  const dirtyKey = mode === "afterDelay" ? autoSaveCandidates(files, isVirtual).map((f) => `${f.path}:${f.content.length}:${f.content.slice(-32)}`).join("|") : "";
  useEffect(() => {
    if (mode !== "afterDelay" || !dirtyKey) return;
    const ms = Math.max(100, Number(delay) || 1000);
    const t = setTimeout(() => saveAll(), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, delay, dirtyKey]);

  // onFocusChange: o arquivo que deixou de ser o ativo.
  const prevActive = useRef<string | null>(activePath);
  useEffect(() => {
    const prev = prevActive.current;
    prevActive.current = activePath;
    if (mode !== "onFocusChange" || !prev || prev === activePath) return;
    saveAll((f) => f.path === prev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, mode]);

  // onFocusChange também vale ao sair da janela (VS Code); onWindowChange só nisso.
  useEffect(() => {
    if (mode !== "onWindowChange" && mode !== "onFocusChange") return;
    const onBlur = () => saveAll();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
}
