import { useEffect, useRef, useState } from "react";
import { registerEditorAction } from "../components/editor/EditorActions";
import { extHost, extLog } from "./client";
import { planExtensionEditorActions, whenKey } from "./editorTitleActions";
import type { HostEvent, InstalledExtension } from "./protocol";
import { extensionViewId } from "../workbench/viewRegistry";

interface Options {
  /** Revela a view `ext:<id>` na região onde ela estiver. */
  reveal: (viewId: string) => void;
  onError: (message: string) => void;
}

/**
 * Registra no título do editor (EditorActions) os botões das extensões
 * hospedadas — Claude Code e Codex com os próprios ícones — e os comandos
 * `editor/title` que elas contribuem, com o `when` avaliado no host (config,
 * setContext) e reavaliado quando o contexto muda. Ver editorTitleActions.ts.
 */
export function useExtensionEditorActions(installed: readonly InstalledExtension[], opts: Options): void {
  const [whenResults, setWhenResults] = useState<Record<string, boolean>>({});
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Avalia os `when` no host (best effort; sem host = só itens sem `when`).
  useEffect(() => {
    const entries = installed.flatMap((e) => (e.editorTitle ?? []).filter((a) => a.when).map((a) => ({ key: whenKey(e.id, a.command), when: a.when! })));
    if (entries.length === 0) return;
    let alive = true;
    let timer: number | undefined;
    const evaluate = () => {
      if (!extHost.info) return;
      void (extHost.call("evaluateWhen", { exprs: entries.map((x) => x.when) }) as Promise<boolean[]>)
        .then((res) => {
          if (!alive || !Array.isArray(res)) return;
          const next: Record<string, boolean> = {};
          entries.forEach((x, i) => (next[x.key] = !!res[i]));
          setWhenResults((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
        })
        .catch((err) => extLog("evaluateWhen falhou", err));
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(evaluate, 120);
    };
    evaluate();
    const off = extHost.on((ev: HostEvent) => {
      if (ev.event === "hostReady" || ev.event === "context" || ev.event === "extensionActivated") schedule();
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      off();
    };
  }, [installed]);

  useEffect(() => {
    const plan = planExtensionEditorActions(installed, whenResults);
    const run = async (extensionId: string, command: string) => {
      await extHost.loadExtension(extensionId);
      await extHost.call("executeCommand", { command, args: [] });
    };
    const offs = plan.map((a) =>
      registerEditorAction({
        id: a.id,
        icon: "extensions",
        iconImage: a.iconImage,
        label: a.label,
        group: a.group,
        order: a.order,
        run: () => {
          if (a.kind === "reveal") optsRef.current.reveal(extensionViewId(a.extensionId));
          for (const command of a.commands) {
            run(a.extensionId, command).catch((err) => optsRef.current.onError(err instanceof Error ? err.message : String(err)));
          }
        },
      }),
    );
    return () => offs.forEach((off) => off());
  }, [installed, whenResults]);
}
