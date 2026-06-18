# ISSUE-38 · Camada de resolução Material (config + resolver + assets)

**Épico:** [Icon Pack — Material + Codicons](../EPIC-icon-pack-monaco.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** — · **Status:** ✅ Concluída

## Contexto

O explorer usava emoji (📄/📁). Queremos os ícones do **Material Icon Theme** (os
mesmos do VS Code) resolvidos por uma camada própria — sem espalhar regras de ícone
pelos componentes.

## Tarefas

- [x] Adicionar dependência `material-icon-theme` (MIT).
- [x] `material-config.ts`: acesso tipado ao `dist/material-icons.json` (mapas de
      `fileNames`/`fileExtensions`/`folderNames` + `iconDefinitions` + fallbacks +
      overrides `light`). Sem sintaxe de bundler, para ser carregável em Node.
- [x] `icon-assets.ts`: `import.meta.glob` (`eager + ?url`) mapeando nome → URL do
      SVG empacotado. Isolado aqui porque é Vite-only.
- [x] `icon-resolver.ts`: cadeia de prioridade (nome exato → extensão → pasta →
      genérico de arquivo → genérico de pasta), com cache do nome resolvido por tema.
- [x] `FileIcon.tsx`: componente `<FileIcon path isDir expanded theme size />`.

## Arquivos

- `src/icon-theme/material/material-config.ts` (novo)
- `src/icon-theme/material/icon-assets.ts` (novo)
- `src/icon-theme/material/icon-resolver.ts` (novo)
- `src/icon-theme/material/FileIcon.tsx` (novo)

## Detalhes técnicos

- Chaves do pacote são lowercase → normalizar antes do lookup.
- Extensão composta mais longa primeiro (`d.ts` antes de `ts`).
- `appsettings.json` não tem nome exato no pacote → cai para `.json` (pela cadeia).
- `iconPath` do JSON (`./../icons/x.svg`) → stem `x` → chave do glob.

## Critérios de aceite

- [x] `resolveFileIconName("Foo.cs") === "csharp"`, `package.json` vence `.json`.
- [x] `resolveFolderIconName("Controllers")` ≠ ícone genérico de pasta.
- [x] Desconhecido cai no genérico de arquivo/pasta.
- [x] `tsc --noEmit` sem erros.
