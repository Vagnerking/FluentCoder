/**
 * Adaptador PEQUENO de configurações usado pelos temas e pelas contribuições
 * de extensões, até existir o núcleo de settings (frente F, `src/settings/`).
 *
 * Hoje grava em `localStorage` (o mesmo idioma de `src/settings/
 * quickOpenSettings.ts`), uma chave por setting com o nome do VS Code
 * (`workbench.colorTheme`…) e o valor em JSON. Quando o núcleo de settings
 * existir, basta `setSettingsBackend(core)` no boot — nenhum consumidor muda.
 */

export interface SettingsBackend {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  /** Avisa mudanças feitas por outro caminho (UI de settings, outra janela). */
  onDidChange?(listener: (key: string) => void): () => void;
}

/** Settings deste módulo (nomes do VS Code quando existem lá). */
export const SETTING = {
  colorTheme: "workbench.colorTheme",
  iconTheme: "workbench.iconTheme",
  productIconTheme: "workbench.productIconTheme",
  /** `true` (padrão): o tema de cor também pinta a UI (tokens Fluent); `false` = só editor e terminal. */
  colorThemeAppliesToUi: "fluent.theme.applyToUi",
  /** Contribuições declarativas de extensões cujo CÓDIGO está bloqueado (padrão `true`). */
  contributionsWhenCodeBlocked: "extensions.applyContributionsWhenCodeBlocked",
  /** Snippets de extensões/usuário no IntelliSense (padrão `true`). */
  snippetsEnabled: "editor.snippetSuggestions.enabled",
} as const;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const localBackend: SettingsBackend = {
  get(key) {
    const raw = storage()?.getItem(key);
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // valor antigo gravado sem JSON
    }
  },
  set(key, value) {
    try {
      if (value === undefined) storage()?.removeItem(key);
      else storage()?.setItem(key, JSON.stringify(value));
    } catch {
      /* armazenamento indisponível: vale só nesta sessão */
    }
  },
  onDidChange(listener) {
    if (typeof window === "undefined") return () => {};
    const h = (e: StorageEvent) => {
      if (e.key) listener(e.key);
    };
    window.addEventListener("storage", h);
    return () => window.removeEventListener("storage", h);
  },
};

let backend: SettingsBackend = localBackend;
const listeners = new Set<(key: string) => void>();
let unhookBackend: (() => void) | undefined = localBackend.onDidChange?.((k) => emit(k));

function emit(key: string): void {
  for (const l of [...listeners]) l(key);
}

/** Aponta o adaptador para outro armazenamento (o núcleo de settings da frente F). */
export function setSettingsBackend(next: SettingsBackend): void {
  unhookBackend?.();
  backend = next;
  unhookBackend = next.onDidChange?.((k) => emit(k));
}

export function getSetting<T>(key: string, fallback: T): T {
  const v = backend.get(key);
  if (v === undefined || v === null) return fallback;
  if (typeof fallback === "boolean") return (typeof v === "boolean" ? v : fallback) as T;
  if (typeof fallback === "number") return (typeof v === "number" && Number.isFinite(v) ? v : fallback) as T;
  if (typeof fallback === "string") return (typeof v === "string" ? v : fallback) as T;
  return v as T;
}

export function setSetting(key: string, value: unknown): void {
  backend.set(key, value);
  emit(key);
}

/** Escuta mudanças de uma ou mais chaves. Devolve o "unsubscribe". */
export function onDidChangeSetting(keys: string | readonly string[], listener: (key: string) => void): () => void {
  const set = new Set(typeof keys === "string" ? [keys] : keys);
  const l = (k: string) => {
    if (set.has(k)) listener(k);
  };
  listeners.add(l);
  return () => listeners.delete(l);
}
