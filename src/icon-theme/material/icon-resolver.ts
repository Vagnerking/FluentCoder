/**
 * Resolução de NOMES de ícone do Material Icon Theme embutido — fachada sobre o
 * motor genérico (`../engine.ts`, a mesma ordem do VS Code). Mantida para quem
 * precisa só do nome do ícone Material; a UI usa `<FileIcon>`, que segue o
 * tema de ícones ATIVO (`../iconThemeService.ts`).
 */
import { materialConfig } from "./material-config";
import { normalizeIconTheme, resolveFileIcon, resolveFolderIcon, type IconThemeDocument } from "../engine";

/** Which palette variant of the theme to resolve against. */
export type IconColorTheme = "dark" | "light";

let doc: IconThemeDocument | null = null;
const material = () => (doc = doc ?? normalizeIconTheme(materialConfig));

/** Nome do ícone Material para um arquivo (nunca vazio: cai no genérico). */
export function resolveFileIconName(pathOrName: string, theme: IconColorTheme = "dark"): string {
  return resolveFileIcon(material(), pathOrName, { variant: theme }) ?? materialConfig.file;
}

/** Nome do ícone Material para uma pasta (`expanded` = aberta). */
export function resolveFolderIconName(pathOrName: string, expanded = false, theme: IconColorTheme = "dark"): string {
  return resolveFolderIcon(material(), pathOrName, { variant: theme, expanded }) ?? (expanded ? materialConfig.folderExpanded : materialConfig.folder);
}
