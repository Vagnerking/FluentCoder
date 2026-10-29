/**
 * Views nativas do app no registro (identidade estável = os ids antigos da
 * activity bar e das abas do painel, para a migração das preferências).
 * O conteúdo de cada uma é renderizado pelo App (`renderView`).
 */
import { viewRegistry, type ViewDescriptor } from "./viewRegistry.ts";

export const FLUENT_CHAT_VIEW = "fluentChat";

const PRIMARY_ONLY = ["primarySidebar"] as const;

export const NATIVE_VIEWS: readonly ViewDescriptor[] = [
  { id: "explorer", title: "Explorador", icon: { codicon: "explorer" }, defaultRegion: "primarySidebar", defaultOrder: 0, activityBar: true },
  { id: "search", title: "Pesquisar", icon: { codicon: "search" }, defaultRegion: "primarySidebar", defaultOrder: 1, activityBar: true },
  { id: "git", title: "Controle do Código-Fonte", icon: { codicon: "sourceControl" }, defaultRegion: "primarySidebar", defaultOrder: 2, activityBar: true },
  { id: "debug", title: "Executar e Depurar", icon: { codicon: "run" }, defaultRegion: "primarySidebar", defaultOrder: 3, activityBar: true },
  { id: "extensions", title: "Extensões", icon: { codicon: "extensions" }, defaultRegion: "primarySidebar", defaultOrder: 4, activityBar: true },
  { id: "packages", title: "Pacotes", icon: { codicon: "packages" }, defaultRegion: "primarySidebar", defaultOrder: 5, activityBar: true },
  // "Grafo de Contextos": o mapa abre como aba do editor; a view é o painel de backlinks.
  { id: "graph", title: "Grafo de Contextos", icon: { codicon: "graph" }, defaultRegion: "primarySidebar", defaultOrder: 6, activityBar: true },
  // Placeholders da base da activity bar: não saem da primária.
  { id: "account", title: "Contas", icon: { codicon: "account" }, defaultRegion: "primarySidebar", defaultOrder: 90, activityBar: true, allowedRegions: PRIMARY_ONLY },
  { id: "settings", title: "Gerenciar", icon: { codicon: "settings" }, defaultRegion: "primarySidebar", defaultOrder: 91, activityBar: true, allowedRegions: PRIMARY_ONLY },
  // Fluent Chat: view própria (a configuração de agentes é um diálogo).
  { id: FLUENT_CHAT_VIEW, title: "Fluent Chat", icon: { codicon: "fluentChat" }, defaultRegion: "secondarySidebar", defaultOrder: 0, retainWhenHidden: true },
  // Painel inferior (ordem padrão antiga: Problemas, Saída, Terminal).
  { id: "problems", title: "Problemas", icon: { codicon: "problems" }, defaultRegion: "panel", defaultOrder: 0 },
  { id: "output", title: "Saída", icon: { codicon: "output" }, defaultRegion: "panel", defaultOrder: 1 },
  // Terminais seguem vivos com a view oculta/movida.
  { id: "terminal", title: "Terminal", icon: { codicon: "terminal" }, defaultRegion: "panel", defaultOrder: 2, retainWhenHidden: true },
];

let registered = false;

/** Registra as views nativas uma vez por janela (idempotente). */
export function registerNativeViews(): void {
  if (registered) return;
  registered = true;
  for (const d of NATIVE_VIEWS) viewRegistry.register(d);
}
