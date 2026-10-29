# Fluent 2 — guia de design do editor

> Referência visual para o Fluent Coder: app **desktop** (Tauri + React + Monaco)
> com **CSS próprio** (`src/styles.css`), tema escuro estilo Windows 11.
>
> Usamos o Fluent 2 só como **base de princípios e tokens** — não usamos a lib
> `@fluentui/react-components`, Figma, Razor/Blazor nem suporte mobile.
>
> Fonte: https://fluent2.microsoft.design — Atualizado em 18/06/2026

---

## 1. Princípios que guiam o projeto

| Princípio | Aplicação no editor |
|---|---|
| **Built for focus** | Reduzir ruído visual. O código é o conteúdo principal; chrome (barras, abas, painéis) fica discreto. |
| **Natural on the platform** | Respeitar convenções do Windows 11: acentos, acrylic/Mica, Segoe UI Variable, comportamento de janela. |
| **Consistent** | Estados (hover/focus/active/selected/disabled) e espaçamentos seguem o mesmo padrão em toda a UI. |

Regras práticas:

- Layouts claros e previsíveis, fáceis de escanear.
- Hierarquia visual conduz o olhar (título → contexto → ação).
- Evitar telas/painéis carregados; uma ação principal por contexto.
- Acessibilidade é critério de aceite, não acabamento.

---

## 2. Tokens (usar sempre, nunca valores soltos)

O editor já mantém seus tokens em `src/styles.css` (`:root`). Ao criar ou
ajustar UI, **reutilize as variáveis existentes** em vez de hexadecimais ou
pixels avulsos. Nomeie tokens novos pelo uso semântico (`--color-bg-surface`),
não pelo valor (`--gray-20`).

### Espaçamento — base 4px

| Token | Valor |
|---|---:|
| `none` | 0 |
| `xxs` | 2 |
| `xs` | 4 |
| `sm` | 8 |
| `md` | 16 |
| `lg` | 24 |
| `xl` | 32 |

Usar para `margin`, `padding`, `gap`. Os valores 2/6/10 existem para ajuste fino
de alinhamento com ícones. Preferir espaçamento a divisores para separar grupos.

### Raio

| Token | Valor | Uso |
|---|---:|---|
| `--radius-xs` | 2 | barras indicadoras, realces inline |
| `--radius-sm` | 4 | controles compactos (botão, input, item de menu/lista) |
| `--radius-control` | 6 | chips, abas, cards pequenos |
| `--radius-surface` / `--radius-card` | 8 | superfícies (side bar, editor, flyout, diálogo) |
| `--radius-pill` | 999 | badges, contadores, chips redondos |

`src/components/ui/tokens.test.ts` falha se surgir `border-radius` ou
`font-size` em px fora do `:root`.

### Tipografia

- Família: `Segoe UI Variable` com fallbacks (já definida no `body`).
- Type ramp semântico (não definir tamanho manual por componente):

| Papel | Token | Tamanho / line-height |
|---|---|---:|
| Caption 2 | `--font-caption-xs` | 10px |
| Overline / hint | `--font-caption-sm` | 11px / 14px |
| Caption | `--font-caption` | 12px / 16px |
| Base (densidade da UI) | `--font-base` | 13px / 18px |
| Body | `--font-body` | 14px / 20px |
| Subtitle | `--font-subtitle` | 16px / 22px |
| Title | `--font-title` | 24px / 32px |

- Pesos: Regular, Semibold, Bold. Line-height confortável em textos longos.

### Cor

- Usar os tokens de tema do `:root` (`--text`, `--accent`, `--editor-bg`,
  `--acrylic-*`, etc.).
- Garantir contraste mínimo:

| Elemento | Contraste |
|---|---:|
| Texto padrão | 4.5:1 |
| Texto grande / ícones / componentes interativos | 3:1 |

- **Nunca** comunicar status só por cor (erro/sucesso/alerta): combinar com
  ícone e/ou texto.
- Foco usa stroke visível e distinto.

---

## 3. Estados interativos

Todo elemento interativo (botões, itens de aba, nós da árvore, comandos) deve
ter: **rest, hover, active/pressed, selected, focus, disabled**. O editor já
expressa isso via tokens `--fill-subtle-hover`, `--fill-subtle-active`,
`--fill-selected*`. Área clicável adequada e foco sempre visível.

---

### Primitivos (`src/components/ui`)

Use-os em vez de recriar controles por feature:

| Primitivo | Quando usar |
|---|---|
| `Button` / `IconButton` | ações; botão só-ícone **sempre** `IconButton` (label vira `aria-label` + Tooltip; nada de `title` nativo) |
| `Input` / `SearchBox` / `Textarea` | campos de texto (sublinhado de destaque no foco; `SearchBox` tem limpar) |
| `Select`, `Checkbox`, `Switch` | escolhas |
| `Tabs` | qualquer tablist (`underline` em painéis/diálogos, `pill` para alternância segmentada) |
| `Menu` | todo menu/flyout de ações (contexto, dropdown da menu bar, menus da status bar) |

Regras puras de teclado/posição ficam em `*Logic.ts` com testes unitários.

### Shell da janela

Title bar, calhas entre os cards e status bar formam **uma superfície só**
(`--shell-bg`); side bar, editor, painéis e activity bar flutuam como cards
(`--radius-surface`, borda acrílica). Não pinte fundo próprio na title bar ou
na status bar.

## 4. Ícones

- Codicons (`@vscode/codicons`) para UI; Material Icon Theme para arquivos/pastas.
- Ícones reforçam ação/contexto — não substituem texto crítico.
- Evitar ícones complexos em tamanhos pequenos; usar variação preenchida para
  estados selecionados quando fizer sentido.

---

## 5. Motion

- Animações curtas e funcionais (abrir/fechar painéis, hover, mudança de estado).
- Nada decorativo que atrase o usuário.
- Respeitar `prefers-reduced-motion`.

---

## 6. Acessibilidade (regra de aceite)

- [ ] Navegação completa por teclado.
- [ ] Foco sempre visível (não remover outline sem substituto).
- [ ] Contraste verificado.
- [ ] `label` / `aria-label` / `aria-describedby` corretos; semântica HTML.
- [ ] Heading hierarchy coerente.
- [ ] Estados de loading acessíveis (`role="status"`).
- [ ] Layout legível com zoom.

---

## 7. Conteúdo

- Labels claros; botões com verbo de ação.
- Mensagens de erro: explicam o problema **e** o próximo passo.
- Estados vazios orientam o que fazer.
- Textos simples, diretos, em português.

---

## 8. Wait UX

- **Skeleton** quando a estrutura é previsível.
- **Spinner** para ações rápidas sem progresso mensurável.
- **Progress bar** quando há progresso conhecido.
- Mensagens: gerúndio em andamento (`Carregando…`), passado ao concluir
  (`Arquivo salvo`).

---

## 9. Checklist antes de finalizar uma tela/painel

- [ ] Hierarquia visual evidente; ação principal fácil de achar.
- [ ] Espaçamento na escala de 4px; conteúdo respira.
- [ ] Tipografia semântica, sem tamanhos manuais avulsos.
- [ ] Cores via tokens; status não depende só de cor.
- [ ] Estados hover/active/disabled/focus presentes.
- [ ] Teclado, foco visível, labels e contraste validados.
- [ ] Textos diretos; erros com próximo passo; estados vazios orientam.
