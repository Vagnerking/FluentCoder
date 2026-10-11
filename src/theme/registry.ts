/**
 * Registro de temas (cores e ícones) — interface mínima entre as settings
 * (`workbench.colorTheme` / `workbench.iconTheme`, pickers da tela de
 * Configurações) e o motor de temas.
 *
 * O core registra os temas embutidos; temas de extensões (contributes.themes /
 * iconThemes) entram por `registerColorThemeProvider`/`registerIconThemeProvider`
 * — o motor de temas é quem sabe aplicá-los. Quem aplica a setting é
 * `src/settings/applyTheme.ts`.
 */

export type ThemeKind = "dark" | "light" | "hc-dark" | "hc-light";

export interface ColorThemeInfo {
  /** Valor gravado em `workbench.colorTheme` (o `label` do VS Code). */
  id: string;
  label: string;
  kind: ThemeKind;
  /** `core` ou id da extensão. */
  source: string;
  description?: string;
}

export interface IconThemeInfo {
  /** Valor gravado em `workbench.iconTheme` (`null` = sem ícones de arquivo). */
  id: string;
  label: string;
  source: string;
}

export interface ColorThemeProvider {
  id: string;
  list(): ColorThemeInfo[];
  /** Aplica o tema; `false` se não é deste provedor. */
  apply(id: string): boolean | Promise<boolean>;
}

export interface IconThemeProvider {
  id: string;
  list(): IconThemeInfo[];
  apply(id: string | null): boolean | Promise<boolean>;
}

export const DEFAULT_COLOR_THEME = "Fluent Acrylic Dark";
export const DEFAULT_ICON_THEME = "material-icon-theme";

type Listener = () => void;

class ThemeRegistry {
  private colorProviders = new Map<string, ColorThemeProvider>();
  private iconProviders = new Map<string, IconThemeProvider>();
  private listeners = new Set<Listener>();

  registerColorThemeProvider(p: ColorThemeProvider): () => void {
    this.colorProviders.set(p.id, p);
    this.changed();
    return () => {
      if (this.colorProviders.get(p.id) === p) this.colorProviders.delete(p.id);
      this.changed();
    };
  }

  registerIconThemeProvider(p: IconThemeProvider): () => void {
    this.iconProviders.set(p.id, p);
    this.changed();
    return () => {
      if (this.iconProviders.get(p.id) === p) this.iconProviders.delete(p.id);
      this.changed();
    };
  }

  listColorThemes(): ColorThemeInfo[] {
    return [...this.colorProviders.values()].flatMap((p) => p.list());
  }

  listIconThemes(): IconThemeInfo[] {
    return [...this.iconProviders.values()].flatMap((p) => p.list());
  }

  async applyColorTheme(id: string): Promise<boolean> {
    for (const p of this.colorProviders.values()) {
      if (p.list().some((t) => t.id === id) && (await p.apply(id))) return true;
    }
    return false;
  }

  async applyIconTheme(id: string | null): Promise<boolean> {
    for (const p of this.iconProviders.values()) {
      if ((id === null || p.list().some((t) => t.id === id)) && (await p.apply(id))) return true;
    }
    return false;
  }

  /** Avisa quando provedores/temas mudam (pickers relistam). */
  onDidChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Provedores chamam quando a lista deles muda (extensão instalada…). */
  changed(): void {
    for (const l of [...this.listeners]) l();
  }
}

export const themeRegistry = new ThemeRegistry();

// Embutidos: o tema escuro Fluent (único hoje) e o Material Icon Theme.
themeRegistry.registerColorThemeProvider({
  id: "core",
  list: () => [{ id: DEFAULT_COLOR_THEME, label: "Fluent Acrylic Dark", kind: "dark", source: "core", description: "Tema padrão (Windows 11)" }],
  apply: (id) => id === DEFAULT_COLOR_THEME,
});
themeRegistry.registerIconThemeProvider({
  id: "core",
  list: () => [{ id: DEFAULT_ICON_THEME, label: "Material Icon Theme", source: "core" }],
  apply: (id) => id === DEFAULT_ICON_THEME,
});
