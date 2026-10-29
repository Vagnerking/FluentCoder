/**
 * Aba "Atalhos de Teclado": lista de comandos (Paleta + ações do editor com
 * atalho) com o atalho efetivo, `when` e origem; busca (por comando ou tecla,
 * `@source:user`), gravação de atalho (captura a combinação), conflitos e
 * remoção/restauração — tudo gravado no `User/keybindings.json` com edição
 * pontual (comentários preservados).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, IconButton, SearchBox } from "../ui";
import { Codicon } from "../../icons/codicons/Codicon";
import { formatKeybinding } from "../../platform/keybinding";
import { settings } from "../../settings/instance";
import { appendToJsoncArray, parseTree, removeFromJsoncArray } from "../../settings/jsonc";
import { chordFromEvent, findConflicts, normalizeKey, type KeybindingRule } from "../../settings/keybindings";
import { currentKeybindings, getAppCommands, keybindingsVersion, onKeybindingsChange } from "../../settings/keybindingRuntime";
import { highlightRanges } from "../../settings/settingsSearch";

export interface KeybindingsEditorProps {
  onOpenFile: (path: string) => void;
}

const SOURCE_LABEL: Record<string, string> = { default: "Padrão", user: "Usuário", extension: "Extensão" };

interface Row {
  command: string;
  title: string;
  detail?: string;
  rule: KeybindingRule | null;
}

function Hl({ text, words }: { text: string; words: string[] }) {
  const r = highlightRanges(text, words);
  if (!r.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  r.forEach(([a, b], i) => {
    out.push(text.slice(last, a), <mark key={i} className="settings-hit">{text.slice(a, b)}</mark>);
    last = b;
  });
  out.push(text.slice(last));
  return <>{out}</>;
}

/** Índice (na lista da raiz do keybindings.json) da regra do usuário. */
function userRuleIndex(text: string, rule: KeybindingRule): number {
  const { root } = parseTree(text);
  const items = root?.type === "array" ? root.children ?? [] : [];
  return items.findIndex((n) => {
    const props = n.children ?? [];
    const get = (k: string) => props.find((p) => p.key?.value === k)?.valueNode?.value;
    return get("command") === rule.command && normalizeKey(String(get("key") ?? "")) === rule.key && (get("when") ?? undefined) === rule.when;
  });
}

async function editUserKeybindings(edit: (text: string) => string): Promise<void> {
  const path = settings.settingsPaths?.userKeybindings;
  if (!path) throw new Error("Perfil do usuário indisponível.");
  const text = settings.textOf(path) ?? "[\n]\n";
  await settings.writeText(path, edit(text));
}

function Recorder({ onDone, onCancel }: { onDone: (key: string) => void; onCancel: () => void }) {
  const [chords, setChords] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const value = chords.join(" ");
  return (
    <div className="kb-recorder-overlay" role="dialog" aria-modal="true" aria-label="Gravar atalho">
      <div
        ref={ref}
        className="kb-recorder"
        tabIndex={0}
        data-keybinding-recorder
        onKeyDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return onCancel();
          if (e.key === "Enter" && chords.length && !e.ctrlKey && !e.altKey && !e.metaKey) return onDone(value);
          const c = chordFromEvent(e.nativeEvent);
          if (!c) return;
          setChords((cur) => (cur.length >= 2 ? [c] : [...cur, c]));
        }}
      >
        <p className="kb-recorder-title">Pressione a combinação desejada e depois Enter</p>
        <kbd className="kb-recorder-keys" aria-live="polite">{value ? formatKeybinding(value) : "…"}</kbd>
        <p className="settings-muted">Até dois acordes (ex.: Ctrl+K Ctrl+S). Esc cancela.</p>
        <div className="kb-recorder-actions">
          <Button size="sm" variant="primary" disabled={!value} onClick={() => onDone(value)}>
            Salvar
          </Button>
          <Button size="sm" onClick={() => setChords([])}>Limpar</Button>
          <Button size="sm" variant="subtle" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </div>
    </div>
  );
}

export function KeybindingsEditor({ onOpenFile }: KeybindingsEditorProps) {
  const version = useSyncExternalStore(onKeybindingsChange, keybindingsVersion);
  const settingsVersion = useSyncExternalStore(settings.subscribe, settings.getVersion);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { effective, errors } = useMemo(() => currentKeybindings(), [version, settingsVersion]);
  const conflicts = useMemo(() => findConflicts(effective), [effective]);
  const conflictKeys = new Set(conflicts.map((c) => c.key));

  const rows = useMemo<Row[]>(() => {
    const cmds = getAppCommands();
    const titles = new Map(cmds.map((c) => [c.id, c]));
    const out: Row[] = [];
    const bound = new Set<string>();
    for (const rule of effective) {
      const c = titles.get(rule.command);
      out.push({ command: rule.command, title: c?.title ?? rule.command, detail: c?.detail, rule });
      bound.add(rule.command);
    }
    for (const c of cmds) {
      if (bound.has(c.id)) continue;
      // Atalho que o próprio comando anuncia (menus/Monaco): exibido como padrão.
      const key = c.keybinding ? normalizeKey(c.keybinding) : "";
      out.push({ command: c.id, title: c.title, detail: c.detail, rule: key ? { key, command: c.id, source: "default" } : null });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective, version]);

  const words = query.toLowerCase().split(/\s+/).filter((w) => w && !w.startsWith("@"));
  const onlyUser = /@source:user/i.test(query);
  const filtered = rows.filter((r) => {
    if (onlyUser && r.rule?.source !== "user") return false;
    const label = r.rule ? `${formatKeybinding(r.rule.key)} ${r.rule.key}` : "";
    const hay = `${r.title} ${r.command} ${r.detail ?? ""} ${label} ${r.rule?.when ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });

  const save = async (row: Row, key: string) => {
    setRecording(null);
    setError(null);
    try {
      await editUserKeybindings((text) => {
        let t = text;
        // Um padrão trocado: remove o antigo (-comando) e grava o novo.
        if (row.rule?.source === "default") t = appendToJsoncArray(t, { key: row.rule.key, command: `-${row.command}` });
        if (row.rule?.source === "user") {
          const i = userRuleIndex(t, row.rule);
          if (i >= 0) t = removeFromJsoncArray(t, i);
        }
        return appendToJsoncArray(t, { key, command: row.command, ...(row.rule?.when ? { when: row.rule.when } : {}) });
      });
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (row: Row) => {
    if (!row.rule) return;
    setError(null);
    try {
      await editUserKeybindings((text) => {
        if (row.rule!.source === "user") {
          const i = userRuleIndex(text, row.rule!);
          return i >= 0 ? removeFromJsoncArray(text, i) : text;
        }
        return appendToJsoncArray(text, { key: row.rule!.key, command: `-${row.command}` });
      });
    } catch (err) {
      setError(String(err));
    }
  };

  const openJson = async () => {
    const path = settings.settingsPaths?.userKeybindings;
    if (!path) return;
    if (settings.textOf(path) == null) await settings.writeText(path, "[\n]\n").catch(() => {});
    onOpenFile(path);
  };

  return (
    <div className="settings-editor kb-editor">
      <header className="settings-header">
        <div className="settings-header-row">
          <h1 className="settings-heading">Atalhos de Teclado</h1>
          <Button size="sm" variant="subtle" icon="openWith" onClick={() => void openJson()}>
            Abrir keybindings.json
          </Button>
        </div>
        <SearchBox
          aria-label="Pesquisar atalhos"
          placeholder="Pesquisar por comando ou tecla (@source:user)"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          contentAfter={<span className="settings-count" role="status">{filtered.length} comandos</span>}
        />
        {conflicts.length > 0 && (
          <p className="setting-warning" role="status">
            <Codicon name="warning" size={12} /> {conflicts.length} {conflicts.length === 1 ? "tecla com conflito" : "teclas com conflito"} (marcadas na lista).
          </p>
        )}
        {[...errors, ...(error ? [error] : [])].map((e, i) => (
          <p key={i} className="setting-error" role="alert">
            <Codicon name="error" size={12} /> {e}
          </p>
        ))}
      </header>
      <div className="kb-table" role="table" aria-label="Atalhos de teclado">
        <div className="kb-row kb-head" role="row">
          <span role="columnheader">Comando</span>
          <span role="columnheader">Atalho</span>
          <span role="columnheader">Quando</span>
          <span role="columnheader">Origem</span>
          <span role="columnheader" className="kb-actions-col" aria-label="Ações" />
        </div>
        <div className="kb-body">
          {filtered.map((r, i) => {
            const conflict = r.rule && conflictKeys.has(r.rule.key);
            return (
              <div key={`${r.command}-${r.rule?.key ?? ""}-${i}`} className={`kb-row${r.rule?.source === "user" ? " is-user" : ""}`} role="row" onDoubleClick={() => setRecording(r)}>
                <span role="cell" className="kb-command">
                  <span className="kb-title"><Hl text={r.title} words={words} /></span>
                  <span className="kb-id"><Hl text={r.command} words={words} /></span>
                </span>
                <span role="cell">
                  {r.rule ? (
                    <kbd className={`kb-key${conflict ? " is-conflict" : ""}`} title={conflict ? "Conflito: outro comando usa esta tecla" : undefined}>
                      {conflict && <Codicon name="warning" size={12} />} {formatKeybinding(r.rule.key)}
                    </kbd>
                  ) : (
                    <span className="settings-muted">—</span>
                  )}
                </span>
                <span role="cell" className="kb-when">{r.rule?.when ?? ""}</span>
                <span role="cell" className="kb-source">{r.rule ? SOURCE_LABEL[r.rule.source] : ""}</span>
                <span role="cell" className="kb-actions">
                  <IconButton icon="editMessage" size="sm" label={`Alterar atalho de ${r.title}`} onClick={() => setRecording(r)} />
                  {r.rule && (
                    <IconButton
                      icon={r.rule.source === "user" ? "discard" : "remove"}
                      size="sm"
                      label={r.rule.source === "user" ? `Restaurar atalho de ${r.title}` : `Remover atalho de ${r.title}`}
                      onClick={() => void remove(r)}
                    />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {recording && <Recorder onCancel={() => setRecording(null)} onDone={(k) => void save(recording, k)} />}
    </div>
  );
}
