# Épico: Icon Pack — Material Icon Theme + Codicons

> **Status:** Concluído
> **Owner:** Vagner
> **Stack:** Tauri 2 · React 18 · TypeScript · Vite

## Visão

Dar ao editor uma identidade visual próxima ao VS Code: **Material Icon Theme**
para ícones de arquivos/pastas (explorer, abas, busca, Quick Open, Git) e
**Codicons** para a interface (ações, botões, diagnósticos, status bar, activity
bar). Antes disso, arquivos/pastas usavam emoji (📄/📁) e a UI usava SVGs
desenhados à mão e glyphs unicode (✕ ⚠ ⎇ ↻ ↓ ↑ ✓), sem identificação por tipo.

## Distinção importante

- **Material Icon Theme** = ícone de **arquivo/pasta** (o que o item _é_).
- **Codicons** = ícone de **ação/estado** (o que o botão _faz_, ou o estado).

São papéis separados, como no VS Code. Nunca misturar: arquivo nunca usa Codicon,
botão de ação nunca usa um SVG de arquivo.

## Estado atual (baseline antes do épico)

- Árvore de arquivos em [TreeNode.tsx](../src/components/TreeNode.tsx) usava
  `node.isDir ? "📁" : "📄"`.
- Activity bar em [ActivityBar.tsx](../src/components/ActivityBar.tsx) tinha 6 SVGs
  inline desenhados à mão.
- Status bar / Problems / Git usavam glyphs unicode soltos.
- O app é **separado do VS Code** (sem extensões — ver memória do projeto), então
  o icon pack vem de pacotes npm embutidos, não de um theme de extensão.

## Decisões

| Item | Decisão |
| --- | --- |
| Fonte dos ícones | Pacotes npm `material-icon-theme` (MIT) + `@vscode/codicons` (MIT) |
| Material no bundle | SVGs **não** inlined; cada um vira asset hasheado (lazy) — ver `vite.config.ts` |
| Codicons no bundle | web-font `.ttf` + CSS, importados uma vez em `Codicon.tsx` |
| Resolução | Camada própria (`icon-resolver`) com cadeia de prioridade + cache |
| Estados de arquivo | **Cor do label + badge git** (decorations), derivado de `git status` + Monaco |
| Tema claro/escuro | Resolver aceita `theme`; Codicons herdam `currentColor` |

## Arquitetura

```
src/icon-theme/
  README.md            ← uso + customização (documentação do épico)
  decorations.ts       ← path → cor/badge (git + diagnósticos)
  material/
    material-config.ts ← JSON tipado do pacote (Node-safe, testável)
    icon-assets.ts     ← nome → URL do SVG (import.meta.glob, Vite-only)
    icon-resolver.ts   ← cadeia de prioridade + cache  ← camada de resolução
    FileIcon.tsx       ← <FileIcon path isDir expanded/>
    icon-resolver.test.ts
src/icons/codicons/
    codicon-map.ts     ← ação → codicon (mapa central)
    Codicon.tsx        ← <Codicon name="save"/>  (importa codicon.css)
```

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [38](issues/ISSUE-38-material-resolver-layer.md) | Camada de resolução Material (config + resolver + assets) | Front | — | M |
| [39](issues/ISSUE-39-codicon-central-map.md) | Codicons: mapa central + componente | Front | — | S |
| [40](issues/ISSUE-40-wire-components-icons.md) | Aplicar ícones nos componentes + decorations | Front | 38, 39 | M |
| [41](issues/ISSUE-41-icon-pack-perf-docs-e2e.md) | Performance (no-inline), docs e E2E | Full | 38–40 | S |

`S` = pequeno, `M` = médio, `L` = grande.

## Critérios de aceite do épico

- [x] Explorer exibe ícones Material para arquivos e pastas.
- [x] Abas exibem ícone Material do arquivo.
- [x] `.cs`, `.cshtml`, `.razor`, `.ts`, `.tsx`, `.json`, `.sql`, `.csproj` têm ícone específico.
- [x] Pastas `Controllers`, `Views`, `Services`, `Repositories`, `Components`, `wwwroot` têm ícone próprio.
- [x] Arquivo/pasta desconhecida usa o ícone genérico (fallback).
- [x] Estados de erro/warning/git visíveis no arquivo (cor do label + badge).
- [x] Interface, ações e diagnósticos usam Codicons via mapa central.
- [x] Mapa de ícones de ação centralizado (`codicon-map.ts`); sem mistura inconsistente.
- [x] Performance: SVGs não inlined; só os exibidos são baixados.
- [x] `tsc --noEmit` e `npm run test:unit` sem erros.
- [x] Documentação de uso e customização ([src/icon-theme/README.md](../src/icon-theme/README.md)).
- [x] E2E (tauri-driver) cobrindo Codicons renderizando com a web-font.

## Riscos / notas

- **Bundle**: o pacote Material tem ~1200 SVGs. Inline-los explodiria o JS de
  startup (~+1 MB). O `assetsInlineLimit` no `vite.config.ts` desliga o inline
  para a pasta `material-icon-theme/icons/`, mantendo o JS enxuto.
- **Teste sob Node**: o resolver importa o JSON via sintaxe de bundler do Vite, que
  o runner de teste do Node não carrega. O teste espelha a cadeia e roda contra o
  JSON real do pacote (ver ISSUE-41).
- **E2E**: pela regra do projeto, ao terminar a feature roda-se `tauri build` +
  tauri-driver (não Playwright/MCP). Ícones de arquivo/pasta dependem de uma pasta
  aberta (picker nativo não dirigível por WebDriver), então a cobertura E2E foca nos
  Codicons sempre visíveis; arquivos/pastas ficam nos testes de unidade.
