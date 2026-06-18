# ISSUE-69 · Editor dividido (grupos) + "Abrir ao lado"

**Épico:** [Ações Avançadas do Explorador](../EPIC-explorer-advanced-actions.md) · **Camada:** Full · **Tamanho:** L · **Depende de:** — · **Status:** ⬜ Pendente

## Contexto

Esta é a **feature base** para qualquer fluxo de edição lado a lado — várias outras ações do explorador
dependem dela, mas ela própria não depende de nenhuma issue anterior; por isso "Depende de: —". Hoje o
editor é de **arquivo único**: [App.tsx](../../src/App.tsx) mantém um único `activePath` e uma lista
plana `openFiles[]`, e [EditorPane.tsx](../../src/components/EditorPane.tsx) renderiza **um** Monaco para
o arquivo ativo. Não existe split nem grupos.

O objetivo é refatorar para um modelo de **grupos de editor**: ao menos dois grupos lado a lado, cada um
com sua própria lista de abas e seu próprio arquivo ativo, mais um "grupo ativo" global (onde novas
aberturas caem por padrão). Com isso, o item **"Abrir ao lado"** (Open to the Side, **Ctrl+Enter**) no
menu de contexto do arquivo abre o arquivo no grupo **vizinho**, criando o segundo grupo se ainda não
existir.

É uma issue grande e arriscada porque mexe no coração do estado do editor. A refatoração deve preservar
**exatamente** o comportamento atual quando há um único grupo (não regredir o fluxo de aba única), e
introduzir o segundo grupo de forma incremental. Os riscos principais estão detalhados abaixo.

## Tarefas

- [ ] Introduzir o conceito de `EditorGroup`: `id`, `openFiles: OpenFile[]`, `activePath: string | null`.
- [ ] Em [App.tsx](../../src/App.tsx), substituir `openFiles`/`activePath` planos por `groups: EditorGroup[]`
      + `activeGroupId`. Manter helpers para o caso de 1 grupo equivalerem ao comportamento atual.
- [ ] Renderizar os grupos lado a lado (layout horizontal) com uma divisória redimensionável entre eles.
- [ ] Cada grupo tem sua própria [TabBar](../../src/components/TabBar.tsx) e seu próprio
      [EditorPane](../../src/components/EditorPane.tsx) (uma instância de Monaco por grupo).
- [ ] Clicar numa aba/editor de um grupo torna esse grupo o `activeGroupId`.
- [ ] Adicionar item **"Abrir ao lado"** no menu de contexto do arquivo (explorador) com acelerador **Ctrl+Enter**.
- [ ] "Abrir ao lado": abre o arquivo no grupo **vizinho** ao ativo; se só houver um grupo, cria o segundo e abre lá.
- [ ] Fechar a última aba de um grupo secundário remove o grupo e o layout volta a um único grupo.
- [ ] Garantir que a guarda de aba suja (ISSUE-67) continue funcionando por grupo.
- [ ] Preservar sessão (`session.json`) — serializar/desserializar os grupos sem quebrar projetos antigos.

## Arquivos

- `src/App.tsx` (modelo de grupos: `groups[]` + `activeGroupId`, layout split, modificado)
- `src/components/EditorPane.tsx` (uma instância por grupo, recebe arquivo/grupo via props, modificado)
- `src/components/TabBar.tsx` (abas por grupo; ação "Abrir ao lado" no menu de contexto, modificado)
- `src/types.ts` (tipo `EditorGroup`, modificado)
- `src/styles.css` (layout `.editor-groups`, divisória redimensionável, grupo ativo, modificado)

## Detalhes técnicos

- Modelo de dados: `groups: EditorGroup[]` e `activeGroupId`. Cada `EditorGroup` carrega seu próprio
  `openFiles[]` (com `dirty` por arquivo) e `activePath`. "Grupo ativo" define onde novas aberturas caem.
- "Abrir ao lado": determina o grupo vizinho do ativo (índice +1; se não existir, cria). Reusa o mesmo
  carregamento de arquivo já usado na abertura normal, só mudando o grupo de destino.
- Uma instância de Monaco por grupo — atenção a `dispose`/recriação ao remover um grupo, para não vazar
  editores. Cada [EditorPane](../../src/components/EditorPane.tsx) recebe explicitamente seu arquivo e callbacks.
- Divisória redimensionável: arraste horizontal ajustando a largura relativa dos grupos (persistir é opcional).
- **Riscos**:
  - Regressão do fluxo de aba única: com 1 grupo, tudo (abrir, salvar, fechar, dirty, Ctrl+W, Ctrl+S) deve
    se comportar como hoje. Garantir cobrindo o caso de 1 grupo como caminho padrão.
  - Mesmo arquivo aberto em dois grupos: decidir e documentar (recomendado permitir, com `dirty` espelhado
    pelo conteúdo do arquivo) — evitar dessincronização de buffers.
  - Atalhos globais (Ctrl+S, Ctrl+W) precisam mirar o **grupo ativo**, não um `activePath` global antigo.
  - Migração de sessão: ler sessões antigas (formato plano) e convertê-las para um único grupo, sem quebrar.
  - Vazamento de instâncias Monaco ao fechar grupos.

## Critérios de aceite

- [ ] Com um único grupo, o comportamento é idêntico ao atual (abrir, editar, salvar, fechar, dirty, atalhos).
- [ ] "Abrir ao lado" (menu de contexto e Ctrl+Enter) abre o arquivo num segundo grupo lado a lado.
- [ ] Se não houver segundo grupo, "Abrir ao lado" o cria; fechar a última aba dele volta a um grupo só.
- [ ] Cada grupo mantém suas próprias abas e arquivo ativo; clicar num grupo o torna o ativo.
- [ ] Ctrl+S / Ctrl+W agem sobre o grupo ativo.
- [ ] A guarda de aba suja (ISSUE-67) funciona em qualquer grupo.
- [ ] Sessões antigas (formato plano) abrem como um único grupo, sem erro.
- [ ] `tsc --noEmit` sem erros.
