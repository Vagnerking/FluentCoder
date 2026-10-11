/**
 * Aba "Configurações" (como o editor de settings do VS Code): busca com
 * destaque e filtros (@modified, @ext:, @lang:, @tag:), árvore de categorias,
 * escopo Usuário / Workspace / Pasta, indicador de modificado + restaurar
 * padrão e controles por tipo (primitivos de src/components/ui). Objetos e
 * listas complexas abrem o settings.json do escopo.
 *
 * Contratos em docs/context/configuracoes.md.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, IconButton, Input, SearchBox, Select, Switch, Tabs } from "../ui";
import { Codicon } from "../../icons/codicons/Codicon";
import { settings, settingsRegistry } from "../../settings/instance";
import { useSettingsVersion } from "../../settings/react";
import { validateSettingValue, type SettingSchema } from "../../settings/registry";
import type { ConfigTarget, Inspection } from "../../settings/model";
import {
  buildSections,
  highlightRanges,
  matchesQuery,
  parseSettingsQuery,
  settingGroupPrefix,
  settingTitle,
  type SettingsSection,
} from "../../settings/settingsSearch";
import { themeRegistry, type ThemeKind } from "../../theme/registry";

export interface SettingsEditorProps {
  /** Abre um arquivo (o settings.json do escopo). */
  onOpenFile: (path: string) => void;
  /** Busca inicial (ex.: "@id:editor.tabSize" vindo de um link). */
  initialQuery?: string;
}

const SCOPE_LABEL: Record<ConfigTarget, string> = { user: "Usuário", workspace: "Workspace", folder: "Pasta" };

function Highlight({ text, words }: { text: string; words: readonly string[] }) {
  const ranges = highlightRanges(text, words);
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  ranges.forEach(([a, b], i) => {
    if (a > last) out.push(text.slice(last, a));
    out.push(
      <mark key={i} className="settings-hit">
        {text.slice(a, b)}
      </mark>,
    );
    last = b;
  });
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Valor da camada do escopo (ou herdado das de baixo), com override de linguagem. */
function scopedValue(i: Inspection, target: ConfigTarget, lang: string | null): { value: unknown; own: unknown } {
  const chain: unknown[] =
    target === "user"
      ? [lang ? i.userLanguageValue : undefined, i.userValue, lang ? i.defaultLanguageValue : undefined, i.defaultValue]
      : target === "workspace"
        ? [lang ? i.workspaceLanguageValue : undefined, i.workspaceValue, lang ? i.userLanguageValue : undefined, i.userValue, i.defaultValue]
        : [lang ? i.workspaceFolderLanguageValue : undefined, i.workspaceFolderValue, i.workspaceValue, i.userValue, i.defaultValue];
  const own =
    target === "user"
      ? lang
        ? i.userLanguageValue
        : i.userValue
      : target === "workspace"
        ? lang
          ? i.workspaceLanguageValue
          : i.workspaceValue
        : lang
          ? i.workspaceFolderLanguageValue
          : i.workspaceFolderValue;
  return { value: chain.find((v) => v !== undefined), own };
}

function otherScopes(i: Inspection, target: ConfigTarget): string[] {
  const out: string[] = [];
  if (target !== "user" && i.userValue !== undefined) out.push("Usuário");
  if (target !== "workspace" && i.workspaceValue !== undefined) out.push("Workspace");
  if (target !== "folder" && i.workspaceFolderValue !== undefined) out.push("Pasta");
  return out;
}

function typesOf(s: SettingSchema): string[] {
  return Array.isArray(s.type) ? s.type : [s.type];
}

const THEME_KEYS: Record<string, ThemeKind> = { "workbench.colorTheme": "color", "workbench.iconTheme": "fileIcon" };

// --------------------------------------------------------------- controles

interface ControlProps {
  schema: SettingSchema;
  value: unknown;
  disabled: boolean;
  labelId: string;
  onChange: (v: unknown) => void;
  onOpenJson: () => void;
}

function TextControl({ value, disabled, labelId, onChange, validate, numeric, step = 1, min, max }: {
  value: string;
  disabled: boolean;
  labelId: string;
  onChange: (v: string) => void;
  validate: (v: string) => string | null;
  numeric?: boolean;
  step?: number;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const error = draft !== value ? validate(draft) : null;
  const commit = (v = draft) => {
    if (v === value || validate(v)) return;
    onChange(v);
  };
  const bump = (dir: 1 | -1) => {
    const n = Number(draft) || 0;
    let next = Math.round((n + dir * step) * 1000) / 1000;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(String(next));
    commit(String(next));
  };
  return (
    <div className="setting-text">
      <div className="setting-text-row">
        <Input
          size="sm"
          aria-labelledby={labelId}
          value={draft}
          disabled={disabled}
          invalid={!!error}
          inputMode={numeric ? "decimal" : undefined}
          wrapperClassName={numeric ? "setting-number" : "setting-string"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setDraft(value);
            if (numeric && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
              e.preventDefault();
              bump(e.key === "ArrowUp" ? 1 : -1);
            }
          }}
        />
        {numeric && (
          <span className="setting-stepper">
            <IconButton icon="remove" size="sm" label="Diminuir" disabled={disabled} onClick={() => bump(-1)} />
            <IconButton icon="add" size="sm" label="Aumentar" disabled={disabled} onClick={() => bump(1)} />
          </span>
        )}
      </div>
      {error && (
        <span className="setting-error" role="alert">
          <Codicon name="error" size={12} /> {error}
        </span>
      )}
    </div>
  );
}

function ListControl({ schema, value, disabled, labelId, onChange }: ControlProps) {
  const items = Array.isArray(value) ? value : [];
  const numeric = typesOf({ ...schema, type: schema.items?.type ?? "string" } as SettingSchema).some((t) => t === "number" || t === "integer");
  const [adding, setAdding] = useState("");
  const parse = (v: string) => (numeric ? Number(v) : v);
  const invalid = (v: string) => (numeric && (!v.trim() || !Number.isFinite(Number(v))) ? "Use um número." : null);
  return (
    <div className="setting-list" role="group" aria-labelledby={labelId}>
      {items.map((item, i) => (
        <div className="setting-list-item" key={i}>
          <span className="setting-list-value">{typeof item === "string" ? item : JSON.stringify(item)}</span>
          <IconButton icon="close" size="sm" label={`Remover ${String(item)}`} disabled={disabled} onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div className="setting-list-add">
        <Input
          size="sm"
          aria-label="Novo item"
          placeholder={numeric ? "Número" : "Novo item"}
          value={adding}
          disabled={disabled}
          invalid={!!adding && !!invalid(adding)}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && adding.trim() && !invalid(adding)) {
              onChange([...items, parse(adding.trim())]);
              setAdding("");
            }
          }}
        />
        <Button
          size="sm"
          icon="add"
          disabled={disabled || !adding.trim() || !!invalid(adding)}
          onClick={() => {
            onChange([...items, parse(adding.trim())]);
            setAdding("");
          }}
        >
          Adicionar item
        </Button>
      </div>
    </div>
  );
}

function SettingControl(p: ControlProps) {
  const { schema, value, disabled, labelId, onChange, onOpenJson } = p;
  const types = typesOf(schema);
  const theme = THEME_KEYS[schema.key];
  if (theme) {
    const list = themeRegistry.list(theme);
    const current = value === null ? "__none__" : String(value ?? "");
    const options = [
      ...list.map((t) => ({ value: t.id, label: t.origin.type === "extension" ? `${t.label} · ${t.origin.extensionName}` : t.label })),
      ...(theme === "fileIcon" ? [{ value: "__none__", label: "Nenhum (sem ícones de arquivo)" }] : []),
    ];
    if (!options.some((o) => o.value === current)) options.push({ value: current, label: `${current} (não instalado)` });
    return <Select size="sm" ariaLabelledBy={labelId} value={current} options={options} disabled={disabled} onChange={(v) => onChange(v === "__none__" ? null : v)} />;
  }
  if (schema.enum) {
    const opts = schema.enum.map((v, i) => ({ value: JSON.stringify(v), label: schema.enumLabels?.[i] ?? (v === "" ? "(padrão)" : String(v)) }));
    return (
      <Select
        size="sm"
        ariaLabelledBy={labelId}
        value={JSON.stringify(value ?? null)}
        options={opts}
        placeholder={String(value)}
        disabled={disabled}
        onChange={(v) => onChange(JSON.parse(v))}
      />
    );
  }
  if (types.includes("boolean") && (types.length === 1 || typeof value === "boolean")) {
    return <Switch checked={value === true} disabled={disabled} aria-labelledby={labelId} label={value === true ? "Ligado" : "Desligado"} onChange={onChange} />;
  }
  if (types.includes("number") || types.includes("integer")) {
    const integer = types.includes("integer");
    return (
      <TextControl
        numeric
        value={value === undefined || value === null ? "" : String(value)}
        disabled={disabled}
        labelId={labelId}
        step={integer || Number.isInteger(Number(value)) ? 1 : 0.1}
        min={schema.minimum}
        max={schema.maximum}
        validate={(v) => {
          if (!v.trim() || !Number.isFinite(Number(v))) return "Use um número.";
          const n = Number(v);
          if (integer && !Number.isInteger(n)) return "Use um número inteiro.";
          return validateSettingValue(schema, n);
        }}
        onChange={(v) => onChange(Number(v))}
      />
    );
  }
  if (types.includes("array") && (!schema.items?.type || ["string", "number", "integer"].includes(String(schema.items.type))) && schema.editor !== "json") {
    return <ListControl {...p} />;
  }
  if (types.includes("string") && schema.editor !== "json") {
    if (/color$/i.test(schema.key) || schema.editor === "color") {
      const hex = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
      return (
        <span className="setting-color">
          <input type="color" aria-labelledby={labelId} value={hex} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
          <TextControl value={String(value ?? "")} disabled={disabled} labelId={labelId} validate={() => null} onChange={onChange} />
        </span>
      );
    }
    return <TextControl value={String(value ?? "")} disabled={disabled} labelId={labelId} validate={(v) => validateSettingValue(schema, v)} onChange={onChange} />;
  }
  return (
    <Button size="sm" icon="openWith" onClick={onOpenJson}>
      Editar no settings.json
    </Button>
  );
}

// ------------------------------------------------------------------ linha

function SettingRow({ schema, target, lang, folder, words, onOpenJson }: {
  schema: SettingSchema;
  target: ConfigTarget;
  lang: string | null;
  folder: string | null;
  words: readonly string[];
  onOpenJson: () => void;
}) {
  const inspection = settings.inspect(schema.key, { resource: folder, languageId: lang });
  const { value, own } = scopedValue(inspection, target, lang);
  const modified = own !== undefined;
  const writable = settings.canWrite(schema.key, target);
  const others = otherScopes(inspection, target);
  const [error, setError] = useState<string | null>(null);
  const labelId = `setting-${schema.key.replace(/[^\w-]/g, "_")}`;
  const opts = { resource: folder, languageId: lang, overrideInLanguage: !!lang };
  const write = (v: unknown) => {
    setError(null);
    settings.update(schema.key, v, target, opts).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  const prefix = settingGroupPrefix(schema);
  return (
    <div className={`setting-row${modified ? " is-modified" : ""}`} data-setting-key={schema.key}>
      <div className="setting-head">
        <span className="setting-label" id={labelId}>
          {prefix && (
            <span className="setting-prefix">
              <Highlight text={prefix} words={words} />:{" "}
            </span>
          )}
          <span className="setting-title">
            <Highlight text={settingTitle(schema)} words={words} />
          </span>
        </span>
        {modified && <span className="setting-badge">Modificado{lang ? ` em [${lang}]` : ""}</span>}
        {others.length > 0 && <span className="setting-also">Também modificado em: {others.join(", ")}</span>}
        <span className="setting-actions">
          {modified && writable && <IconButton icon="discard" size="sm" label={`Restaurar padrão de ${settingTitle(schema)}`} onClick={() => write(undefined)} />}
        </span>
      </div>
      <p className="setting-desc">
        <Highlight text={schema.description} words={words} />
      </p>
      <div className="setting-key">
        <Highlight text={schema.key} words={words} />
      </div>
      {schema.deprecationMessage && <p className="setting-warning"><Codicon name="warning" size={12} /> {schema.deprecationMessage}</p>}
      <div className="setting-control">
        <SettingControl schema={schema} value={value} disabled={!writable} labelId={labelId} onChange={write} onOpenJson={onOpenJson} />
      </div>
      {!writable && (
        <p className="setting-note">
          <Codicon name="info" size={12} /> {schema.scope === "application" || schema.scope === "machine" ? "Só pode ser alterada nas configurações do Usuário." : "Não pode ser alterada por pasta."}
        </p>
      )}
      {error && (
        <p className="setting-error" role="alert">
          <Codicon name="error" size={12} /> {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ editor

export function SettingsEditor({ onOpenFile, initialQuery = "" }: SettingsEditorProps) {
  const version = useSettingsVersion();
  const [registryRev, setRegistryRev] = useState(settingsRegistry.revision);
  useEffect(() => settingsRegistry.onDidChange(() => setRegistryRev(settingsRegistry.revision)), []);
  const [themeRev, setThemeRev] = useState(0);
  useEffect(() => themeRegistry.onDidChange(() => setThemeRev((n) => n + 1)), []);
  const [query, setQuery] = useState(initialQuery);
  const [target, setTarget] = useState<ConfigTarget>("user");
  const targets = settings.availableTargets();
  const roots = settings.workspaceDescriptor.roots;
  const [folder, setFolder] = useState<string | null>(roots[0] ?? null);
  useEffect(() => {
    if (!targets.includes(target)) setTarget("user");
    if (folder && !roots.includes(folder)) setFolder(roots[0] ?? null);
  }, [targets, target, roots, folder]);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const q = useMemo(() => parseSettingsQuery(query), [query]);
  const scopeFolder = target === "folder" ? folder : null;
  const sections: SettingsSection[] = useMemo(() => {
    const isModified = (key: string) => {
      const i = settings.inspect(key, { resource: scopeFolder, languageId: q.lang });
      return scopedValue(i, target, q.lang).own !== undefined;
    };
    return buildSections(settingsRegistry.all().filter((s) => matchesQuery(s, q, isModified)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, version, registryRev, target, scopeFolder]);
  const total = sections.reduce((n, s) => n + s.count, 0);

  const openJson = async () => {
    const path = settings.fileFor(target, scopeFolder);
    if (!path) return;
    if (settings.textOf(path) == null) await settings.writeText(path, "{\n}\n").catch(() => {});
    onOpenFile(path);
  };

  const jump = (id: string) => {
    setActiveSection(id);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    el?.scrollIntoView({ block: "start" });
  };

  // Seção visível acompanha a rolagem (destaque na árvore).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      const heads = [...list.querySelectorAll<HTMLElement>("[data-section]")];
      const top = list.getBoundingClientRect().top + 8;
      let current = heads[0]?.dataset.section ?? null;
      for (const h of heads) if (h.getBoundingClientRect().top <= top) current = h.dataset.section ?? current;
      setActiveSection(current);
    };
    onScroll();
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, [sections]);

  void themeRev;
  const scopeItems = targets.map((t) => ({ value: t, label: SCOPE_LABEL[t] }));

  return (
    <div ref={rootRef} className={`settings-editor${narrow ? " is-narrow" : ""}`}>
      <header className="settings-header">
        <div className="settings-header-row">
          <h1 className="settings-heading">Configurações</h1>
          <Button size="sm" variant="subtle" icon="openWith" onClick={() => void openJson()}>
            Abrir settings.json
          </Button>
        </div>
        <SearchBox
          aria-label="Pesquisar configurações"
          placeholder="Pesquisar configurações (@modified, @lang:python, @ext:id, @tag:)"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          contentAfter={<span className="settings-count" role="status">{total} {total === 1 ? "configuração" : "configurações"}</span>}
        />
        <div className="settings-scope-row">
          <Tabs ariaLabel="Escopo" items={scopeItems} value={target} onChange={(v) => setTarget(v)} size="sm" />
          {target === "folder" && roots.length > 1 && (
            <Select
              size="sm"
              ariaLabel="Pasta"
              value={folder ?? ""}
              options={roots.map((r) => ({ value: r, label: r.split(/[\\/]/).pop() || r }))}
              onChange={(v) => setFolder(v)}
            />
          )}
          {q.lang && <span className="settings-lang">Linguagem: [{q.lang}]</span>}
          <span className="settings-file" title={settings.fileFor(target, scopeFolder) ?? ""}>
            {settings.fileFor(target, scopeFolder) ?? "Abra uma pasta para configurar o workspace"}
          </span>
        </div>
      </header>
      <div className="settings-body">
        {narrow ? (
          <div className="settings-toc-select">
            <Select
              size="sm"
              ariaLabel="Categoria"
              value={activeSection ?? sections[0]?.id ?? ""}
              placeholder="Categoria"
              options={sections.map((s) => ({ value: s.id, label: `${s.label} (${s.count})` }))}
              onChange={jump}
            />
          </div>
        ) : (
          <nav className="settings-toc" aria-label="Categorias">
            <ul>
              {sections.map((s) => (
                <li key={s.id}>
                  <button type="button" className={`settings-toc-item${activeSection === s.id ? " is-active" : ""}`} aria-current={activeSection === s.id ? "true" : undefined} onClick={() => jump(s.id)}>
                    <span>{s.label}</span>
                    <span className="settings-toc-count">{s.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div ref={listRef} className="settings-list" role="region" aria-label="Lista de configurações">
          {sections.length === 0 && (
            <div className="settings-empty">
              <Codicon name="search" size={20} />
              <p>Nenhuma configuração encontrada.</p>
              <p className="settings-muted">Tente outras palavras ou remova os filtros (@modified, @ext:…).</p>
            </div>
          )}
          {sections.map((s) => (
            <section key={s.id} className="settings-section" aria-labelledby={`settings-sec-${s.id}`}>
              <h2 className="settings-section-title" id={`settings-sec-${s.id}`} data-section={s.id}>
                {s.label}
              </h2>
              {s.groups.map((g) => (
                <div key={g.id} className="settings-group">
                  {s.groups.length > 1 || g.label !== s.label ? <h3 className="settings-group-title">{g.label}</h3> : null}
                  {g.settings.map((schema) => (
                    <SettingRow key={schema.key} schema={schema} target={target} lang={q.lang} folder={scopeFolder} words={q.words} onOpenJson={() => void openJson()} />
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
