# ISSUE-66 · Componente ConfirmDialog reutilizável (modal Fluent 2)

**Épico:** [Guarda de Alterações Não Salvas](../EPIC-unsaved-changes-guard.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** — · **Status:** ⬜ Pendente

## Contexto

Esta issue cria um componente de diálogo de confirmação **reutilizável e puramente apresentacional**,
sem nenhuma lógica de negócio. O `ConfirmDialog` é um modal Fluent 2 que apresenta um título, uma
mensagem e uma lista de botões configuráveis, devolvendo ao chamador a escolha do usuário. Ele será
consumido por vários fluxos do app: fechar uma aba suja (Salvar / Não salvar / Cancelar) e excluir um
arquivo (Mover para a Lixeira / Cancelar), entre outros futuros.

O modal é renderizado fora da árvore principal via `createPortal`, com um overlay escurecido e uma
superfície acrílica centralizada. Segue as regras de acessibilidade de diálogo: `role="dialog"`,
`aria-modal="true"`, foco preso dentro do modal (focus trap com ciclo de Tab), **Esc** equivale a
cancelar e o botão default fica destacado e recebe foco inicial.

A API é dirigida por props/dados: o chamador descreve os botões (label, variante e o valor a retornar)
e recebe a escolha de volta por Promise ou callback. O componente não conhece "salvar", "excluir" nem
qualquer ação concreta — apenas exibe opções e reporta qual foi escolhida.

## Tarefas

- [ ] Criar `src/components/ConfirmDialog.tsx` — componente apresentacional, sem lógica de negócio.
- [ ] Definir os tipos da API: `ConfirmButton` (`label`, `variant: 'primary' | 'secondary' | 'danger'`,
      `value: T`, `default?: boolean`) e as props do diálogo (`title`, `message`, `buttons: ConfirmButton<T>[]`).
- [ ] Renderizar via `createPortal`: overlay + superfície acrílica centralizada.
- [ ] Aplicar `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (título) e `aria-describedby` (mensagem).
- [ ] Implementar **focus trap**: Tab/Shift+Tab ciclam apenas pelos botões/elementos do modal; foco inicial
      no botão `default`.
- [ ] **Esc** fecha resolvendo como cancelar (valor do botão secundário de cancelamento, ou `null`).
- [ ] Clique fora (no overlay) também cancela.
- [ ] Botão `default` recebe destaque visual e responde a **Enter**.
- [ ] Retornar a escolha do usuário via Promise (ex.: helper `confirm(opts): Promise<T | null>`) ou callback `onChoice(value)`.
- [ ] Suportar os dois usos previstos só pela configuração de botões (fechar aba e excluir arquivo).
- [ ] CSS Fluent em [styles.css](../../src/styles.css): overlay, superfície, título, mensagem, linha de botões e variantes.

## Arquivos

- `src/components/ConfirmDialog.tsx` (novo)
- `src/types.ts` (tipos `ConfirmButton` / props do diálogo, modificado)
- `src/styles.css` (estilos `.confirm-overlay`, `.confirm-dialog`, `.confirm-actions`, variantes, modificado)

## Detalhes técnicos

- Renderizar sempre via `createPortal` no `document.body`, acima de todo o layout (z-index alto), com
  overlay semitransparente que escurece o fundo.
- A superfície usa o padrão acrílico Fluent 2 já presente no app (ver dropdowns em [styles.css](../../src/styles.css)):
  cantos arredondados, sombra de elevação, paleta `--text` / `--text-muted` e cor de acento.
- Focus trap: ao montar, guardar o elemento previamente focado e devolver o foco a ele ao desmontar;
  enquanto aberto, conter o ciclo de Tab dentro do modal.
- Variantes de botão: `primary` (acento), `secondary` (neutro), `danger` (vermelho) — apenas estilo,
  o significado é decidido pelo chamador via `value`.
- O componente é genérico em `T` (o tipo do valor de retorno), permitindo que cada chamador defina seu
  próprio conjunto de respostas (ex.: `'save' | 'discard' | 'cancel'`).
- **Sem** chamadas a `write_file`, sem acesso a `openFiles` nem a qualquer estado de App — isolamento total.

## Critérios de aceite

- [ ] O modal abre centralizado sobre um overlay e prende o foco internamente.
- [ ] Esc e clique no overlay cancelam (resolvendo o valor de cancelamento).
- [ ] O botão default recebe foco inicial e dispara com Enter.
- [ ] A escolha do usuário chega ao chamador via Promise/callback com o `value` correto.
- [ ] Configurar 3 botões (Salvar / Não salvar / Cancelar) e 2 botões (Mover para a Lixeira / Cancelar)
      funciona sem alterar o componente.
- [ ] Roles ARIA (`dialog`, `aria-modal`, `aria-labelledby`, `aria-describedby`) presentes.
- [ ] `tsc --noEmit` sem erros.
