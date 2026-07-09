import { useCallback, useEffect, useState } from "react";
import {
  nugetList,
  nugetSearch,
  nugetAdd,
  nugetRemove,
  type NugetPackage,
  type NugetSearchHit,
} from "../api";
import { useModalDismiss } from "./useModalDismiss";

interface NugetManagerProps {
  /** The `.csproj` paths in the workspace (from the caller). */
  csprojs: string[];
  onClose: () => void;
}

type Tab = "installed" | "browse";

/** Compact download count, e.g. 8_649_619_643 → "8.6B". */
function fmtDownloads(n: number | null): string {
  if (n == null) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * NuGet package manager (milestone #11). A modal to view installed packages of a
 * `.csproj` (flagging available updates), browse nuget.org, and add/update/remove
 * packages — all via the `dotnet` CLI. The C# Dev Kit ships this on its Solution
 * Explorer; here it's a standalone panel keyed to a selected project.
 */
export function NugetManager({ csprojs, onClose }: NugetManagerProps) {
  const [csproj, setCsproj] = useState(csprojs[0] ?? "");
  const [tab, setTab] = useState<Tab>("installed");
  const [installed, setInstalled] = useState<NugetPackage[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NugetSearchHit[]>([]);
  const [busy, setBusy] = useState<string>(""); // package id being mutated, or "search"/"load"
  const [error, setError] = useState<string | null>(null);

  const loadInstalled = useCallback(async () => {
    if (!csproj) return;
    setBusy("load");
    setError(null);
    try {
      setInstalled(await nugetList(csproj));
    } catch (err) {
      setError(String(err));
      setInstalled([]);
    } finally {
      setBusy("");
    }
  }, [csproj]);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  // Debounced nuget.org search while on the Browse tab.
  useEffect(() => {
    const q = query.trim();
    // Nothing to search (wrong tab or empty query): clear any lingering "search"
    // busy so the modal never freezes when the query is emptied mid-request.
    if (tab !== "browse" || !q) {
      setHits([]);
      setBusy((b) => (b === "search" ? "" : b));
      return;
    }
    let cancelled = false;
    setBusy("search");
    const timer = setTimeout(() => {
      nugetSearch(q)
        .then((r) => !cancelled && setHits(r))
        .catch((err) => !cancelled && setError(String(err)))
        .finally(() => !cancelled && setBusy(""));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, tab]);

  const mutate = async (
    id: string,
    fn: () => Promise<{ success: boolean; output: string }>
  ) => {
    setBusy(id);
    setError(null);
    try {
      const r = await fn();
      if (!r.success) setError(r.output || `Falha ao alterar ${id}`);
      await loadInstalled();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("");
    }
  };

  const installedIds = new Set((installed ?? []).map((p) => p.id.toLowerCase()));

  return (
    <div className="quick-open-backdrop" {...useModalDismiss(onClose)}>
      <div className="quick-open nuget-manager">
        <div className="quick-pick-title">Gerenciar Pacotes NuGet</div>

        <div className="nuget-toolbar">
          <select
            className="search-input"
            value={csproj}
            onChange={(e) => setCsproj(e.target.value)}
            disabled={busy !== ""}
            aria-label="Projeto"
          >
            {csprojs.map((p) => (
              <option key={p} value={p}>
                {p.split(/[\/]/).pop()}
              </option>
            ))}
          </select>
          <div className="nuget-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "installed"}
              className={"nuget-tab" + (tab === "installed" ? " active" : "")}
              onClick={() => setTab("installed")}
            >
              Instalados{installed ? ` (${installed.length})` : ""}
            </button>
            <button
              role="tab"
              aria-selected={tab === "browse"}
              className={"nuget-tab" + (tab === "browse" ? " active" : "")}
              onClick={() => setTab("browse")}
            >
              Procurar
            </button>
          </div>
        </div>

        {tab === "browse" && (
          <input
            className="quick-open-input"
            type="text"
            placeholder="Buscar no nuget.org…"
            value={query}
            aria-label="Buscar pacotes no nuget.org"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        )}

        {error && <div className="git-error nuget-error">{error}</div>}

        <div className="quick-open-list nuget-list" role="listbox">
          {tab === "installed" ? (
            installed == null ? (
              <div className="quick-open-empty">Carregando…</div>
            ) : installed.length === 0 ? (
              <div className="quick-open-empty">Nenhum pacote instalado.</div>
            ) : (
              installed.map((p) => {
                const hasUpdate =
                  p.latestVersion != null && p.latestVersion !== p.resolvedVersion;
                return (
                  <div key={p.id} className="nuget-row">
                    <div className="nuget-info">
                      <span className="nuget-id">{p.id}</span>
                      <span className="nuget-version">
                        {p.resolvedVersion}
                        {hasUpdate && (
                          <span className="nuget-update"> → {p.latestVersion}</span>
                        )}
                      </span>
                    </div>
                    <div className="nuget-actions">
                      {hasUpdate && (
                        <button
                          className="git-link-btn"
                          disabled={busy !== ""}
                          onClick={() =>
                            void mutate(p.id, () =>
                              nugetAdd(csproj, p.id, p.latestVersion ?? undefined)
                            )
                          }
                        >
                          {busy === p.id ? "…" : "Atualizar"}
                        </button>
                      )}
                      <button
                        className="git-link-btn nuget-remove-btn"
                        disabled={busy !== ""}
                        onClick={() => void mutate(p.id, () => nugetRemove(csproj, p.id))}
                      >
                        {busy === p.id ? "…" : "Remover"}
                      </button>
                    </div>
                  </div>
                );
              })
            )
          ) : query.trim() === "" ? (
            <div className="quick-open-empty">Digite para buscar pacotes.</div>
          ) : hits.length === 0 ? (
            <div className="quick-open-empty">
              {busy === "search" ? "Procurando…" : "Nenhum pacote encontrado."}
            </div>
          ) : (
            hits.map((h) => {
              const already = installedIds.has(h.id.toLowerCase());
              return (
                <div key={h.id} className="nuget-row">
                  <div className="nuget-info">
                    <span className="nuget-id">{h.id}</span>
                    <span className="nuget-version">
                      {h.latestVersion}
                      {h.owners && <span className="nuget-owners"> · {h.owners}</span>}
                      {h.totalDownloads != null && (
                        <span className="nuget-downloads"> · {fmtDownloads(h.totalDownloads)} ↓</span>
                      )}
                    </span>
                  </div>
                  <div className="nuget-actions">
                    <button
                      className="git-link-btn"
                      disabled={busy !== "" || already}
                      onClick={() => void mutate(h.id, () => nugetAdd(csproj, h.id))}
                    >
                      {already ? "Instalado" : busy === h.id ? "…" : "Instalar"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
