/**
 * Recomendações de extensões do workspace (`.vscode/extensions.json` de cada
 * raiz local + `extensions.recommendations` do `.code-workspace`), no formato
 * das recomendadas embutidas da view Extensões. Some com
 * `extensions.ignoreRecommendations`. As embutidas (Claude Code, Codex) não se
 * repetem aqui.
 */
import { useEffect, useState } from "react";
import { RECOMMENDED, type Recommendation } from "../extensions/catalog";
import { settings } from "./instance";
import { useSetting, useSettingsVersion } from "./react";
import { loadWorkspaceRecommendations } from "./vscodeFiles";

export function recommendationFromId(id: string): Recommendation {
  const dot = id.indexOf(".");
  const namespace = id.slice(0, dot);
  const name = id.slice(dot + 1);
  return {
    id,
    namespace,
    name,
    label: name,
    publisher: namespace,
    description: "Recomendada pelo workspace (.vscode/extensions.json).",
    officialUrl: `https://open-vsx.org/extension/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
  };
}

export function useWorkspaceRecommendations(): Recommendation[] {
  const ignore = useSetting<boolean>("extensions.ignoreRecommendations") === true;
  useSettingsVersion();
  const desc = settings.workspaceDescriptor;
  const key = `${desc.roots.join("|")}::${desc.workspaceFile ?? ""}`;
  const [recs, setRecs] = useState<Recommendation[]>([]);
  useEffect(() => {
    if (ignore || desc.roots.length === 0) {
      setRecs([]);
      return;
    }
    let alive = true;
    const builtin = new Set(RECOMMENDED.map((r) => r.id.toLowerCase()));
    void loadWorkspaceRecommendations(desc.roots).then((r) => {
      if (alive) setRecs(r.recommendations.filter((id) => !builtin.has(id)).map(recommendationFromId));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ignore]);
  return recs;
}
