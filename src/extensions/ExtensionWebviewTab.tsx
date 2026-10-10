/**
 * Corpo de uma aba de painel de webview no grupo de editores. Mantém o iframe
 * montado enquanto a aba existir no grupo (retainContextWhenHidden) e publica
 * o estado de visualização ao host (`WebviewPanel.active/visible/viewColumn` +
 * `onDidChangeViewState`).
 */
import { useEffect, useSyncExternalStore } from "react";
import { extHost } from "./client";
import { ExtensionWebview } from "./ExtensionWebview";
import { subscribeWebviewPanels, webviewPanelsSnapshot } from "./webviewTabs";

interface Props {
  handle: string;
  /** A aba é a ativa do grupo (o iframe aparece). */
  visible: boolean;
  /** …e o grupo é o ativo (o painel é o `active` do VS Code). */
  active: boolean;
  /** Coluna (1-based) do grupo na grade. */
  viewColumn: number;
}

export function ExtensionWebviewTab({ handle, visible, active, viewColumn }: Props) {
  const panels = useSyncExternalStore(subscribeWebviewPanels, webviewPanelsSnapshot);
  const info = panels.get(handle);

  useEffect(() => {
    void extHost.notify("webviewPanelState", { handle, visible, active: visible && active, viewColumn });
  }, [handle, visible, active, viewColumn]);

  if (!info) {
    return (
      <div className="ext-webview-status" role="status">
        Este painel da extensão foi encerrado.
      </div>
    );
  }
  return <ExtensionWebview info={info} visible={visible} />;
}
