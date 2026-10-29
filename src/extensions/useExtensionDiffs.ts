import { useCallback, useSyncExternalStore } from "react";
import { extHost, hostOutput } from "./client";
import { extDiffsSnapshot, removeExtDiff, setExtDiffError, subscribeExtDiffs, type ExtPendingDiff } from "./diffs";


/**
 * Fila de diffs das extensões para a revisão do Monaco (`ClaudeDiffReview`).
 * Aceitar manda o texto final (o lado direito é editável) ao comando de
 * aceitar da própria extensão; Rejeitar idem (ou fecha a aba, que o VS Code
 * também trata como rejeição). Erro mantém a revisão aberta com a mensagem.
 */
export function useExtensionDiffs(): {
  diffs: ExtPendingDiff[];
  accept: (id: string, finalText: string) => Promise<void>;
  reject: (id: string) => void;
} {
  const diffs = useSyncExternalStore(subscribeExtDiffs, extDiffsSnapshot);

  const accept = useCallback(async (id: string, finalText: string) => {
    setExtDiffError(id, undefined);
    try {
      const r = (await extHost.call("diffAction", { diffId: id, action: "accept", text: finalText })) as { ok: boolean; error?: string; via?: string } | null;
      if (!r?.ok) {
        setExtDiffError(id, r?.error ? `${r.error}.` : "A extensão não aceitou a alteração.");
        return;
      }
      hostOutput(`Diff aceito (${r.via}).`);
      // A decisão foi entregue à extensão: a revisão sai da fila. A aba do diff
      // no host fecha quando a extensão/CLI pedir (close_tab), como no VS Code.
      removeExtDiff(id);
    } catch (err) {
      setExtDiffError(id, err instanceof Error ? err.message : String(err));
    }
  }, []);

  const reject = useCallback((id: string) => {
    removeExtDiff(id);
    void (extHost.call("diffAction", { diffId: id, action: "reject" }) as Promise<{ ok: boolean } | null>)
      .then((r) => {
        // Sem comando de rejeitar: fechar a aba (o VS Code trata como rejeição).
        if (!r?.ok) void extHost.notify("diffClosed", { diffId: id });
      })
      .catch(() => {});
  }, []);

  return { diffs, accept, reject };
}
