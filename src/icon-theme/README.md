# Icon pack — Material Icon Theme + Codicons

Camada de ícones do editor. Duas bibliotecas, papéis separados (como no VS Code):

| Uso                                   | Biblioteca            | Onde fica            |
| ------------------------------------- | --------------------- | -------------------- |
| Arquivos, pastas, abas, resultados    | **Material Icon Theme** | `src/icon-theme/material/` |
| Ações, botões, diagnósticos, status   | **Codicons**          | `src/icons/codicons/`      |

Regra de ouro: **componentes não decidem ícones**. Eles pedem por _nome de arquivo_
ou por _ação semântica_ e a camada resolve. Nenhuma regra de ícone fica espalhada
nas telas.

---

## 1. Material Icon Theme (arquivos e pastas)

Usa o pacote npm [`material-icon-theme`](https://www.npmjs.com/package/material-icon-theme)
(licença MIT) — os mesmos ~1200 SVGs e o mesmo JSON de associações do VS Code.
Não reimplementamos os dados; lemos e resolvemos contra eles.

### Arquivos

- [`material-config.ts`](material/material-config.ts) — acesso tipado ao JSON do
  pacote (sem sintaxe de bundler; carregável em Node, por isso é testável).
- [`icon-assets.ts`](material/icon-assets.ts) — mapeia o nome do ícone → **URL** do
  SVG empacotado, via `import.meta.glob` do Vite. Só esta camada usa Vite.
- [`icon-resolver.ts`](material/icon-resolver.ts) — a camada de resolução: aplica a
  cadeia de prioridade e faz cache do nome resolvido.
- [`FileIcon.tsx`](material/FileIcon.tsx) — componente React. `<FileIcon path=… isDir=… />`.

### Cadeia de resolução (prioridade)

1. **Nome exato** do arquivo — `package.json`, `Dockerfile`, `tsconfig.json`
2. **Extensão** — `.cs`, `.ts`, `.json` (extensão composta mais longa primeiro)
3. **Nome exato** da pasta — `Controllers`, `wwwroot`, `node_modules`
4. **Ícone genérico** de arquivo (fallback)
5. **Ícone genérico** de pasta (fallback)

Exemplos: `package.json` (nome exato) vence `.json`; `appsettings.json` (sem nome
exato) cai para `.json`; arquivo/pasta desconhecida usa o ícone genérico.

### Performance

Os SVGs **não** são embutidos no bundle JS. O [`vite.config.ts`](../../vite.config.ts)
desliga o inline para `material-icon-theme/icons/`, então cada SVG vira um asset
hasheado próprio — o navegador busca só os ícones realmente exibidos e os mantém em
cache. A tabela de URLs (resolvida em build) cobre todos os ícones, mas os _bytes_
do SVG só são baixados sob demanda. Nomes resolvidos têm cache em memória no resolver.

### Tema claro/escuro

`resolveFile/FolderIconName(name, … , theme)` aceita `"dark"` (padrão) ou `"light"`;
o pacote traz overrides de ícone para o tema claro e a resolução os aplica.

---

## 2. Codicons (interface, ações, diagnósticos)

Usa [`@vscode/codicons`](https://www.npmjs.com/package/@vscode/codicons) (web-font +
CSS; licença MIT no código, ícones CC-BY 4.0). Importado uma única vez em
[`Codicon.tsx`](../icons/codicons/Codicon.tsx).

### Arquivos

- [`codicon-map.ts`](../icons/codicons/codicon-map.ts) — **mapa central** ação →
  nome do codicon. É a única fonte de verdade. Trocar o glyph de uma ação = uma linha.
- [`Codicon.tsx`](../icons/codicons/Codicon.tsx) — `<Codicon name="save" />`.

Cor e tamanho herdam do texto ao redor (`currentColor`, `font-size`), então o ícone
combina com o botão e funciona em tema claro e escuro de graça.

### Exemplo do mapa

```
save     -> codicon-save
search   -> codicon-search
error    -> codicon-error
warning  -> codicon-warning
quickFix -> codicon-lightbulb
settings -> codicon-settings-gear
```

---

## Estados visuais de arquivo (decorations)

Modificado / novo / erro / warning / conflito etc. são mostrados **colorindo o label**
e exibindo um **badge git** no fim da linha (estilo VS Code) — não alteram o SVG do ícone.
Derivados de `git status` + diagnósticos do Monaco em
[`decorations.ts`](decorations.ts); diagnóstico (erro/aviso) tem precedência sobre o
estado git. As cores vivem em `styles.css` (classes `.deco-*`).

---

## Como adicionar / customizar ícones

**Ícone de arquivo/pasta (Material):** as associações vêm do pacote. Para forçar uma
associação própria, edite os mapas em `material-config.ts` (ou um override antes de
exportar `materialConfig`) — a ordem da cadeia em `icon-resolver.ts` faz o resto.
Após mudar associações em runtime, chame `clearIconCache()`.

**Ícone de ação (Codicon):** adicione a chave em `IconAction` e a linha correspondente
em `CODICON_MAP` (nome existente em `@vscode/codicons`). Depois é só `<Codicon name="…" />`.
Para um ícone que gira (loading), adicione a chave em `SPINNING`.

**Cor de estado:** edite as classes `.deco-*` em `styles.css`.

## Testes

- Unidade: [`icon-resolver.test.ts`](material/icon-resolver.test.ts) cobre a cadeia de
  prioridade contra o JSON real do pacote (`npm run test:unit`).
- E2E: [`tests/e2e/specs/icon-pack.e2e.ts`](../../tests/e2e/specs/icon-pack.e2e.ts)
  verifica os Codicons renderizando com a web-font na janela Tauri real.
