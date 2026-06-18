# ISSUE-70 · "Open With…": escolher como abrir o arquivo

**Épico:** [Ações Avançadas do Explorador](../EPIC-explorer-advanced-actions.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 56 · **Status:** ⬜ Pendente

## Contexto

Hoje cada arquivo abre num modo fixo (texto no Monaco, ou o preview de imagem para tipos de imagem).
Esta issue adiciona o item **"Open With…"** ao menu de contexto do arquivo no explorador, permitindo ao
usuário escolher **como** abrir aquele arquivo dentre os modos disponíveis.

Os modos iniciais são: **Editor de Texto** (Monaco, [EditorPane.tsx](../../src/components/EditorPane.tsx))
e **Preview de Imagem** (o modo "Open in Images Preview" já existente no app). A lista deve ser
**extensível** no futuro (novos modos como hex, markdown preview, etc.) sem reescrever a UI. Para o tipo
de arquivo selecionado, apenas os modos **aplicáveis** são oferecidos (ex.: Preview de Imagem só aparece
para imagens), com o modo padrão daquele tipo destacado.

A escolha é feita por um pequeno seletor — pode reaproveitar o componente de menu de contexto / quick-pick
já usado no explorador (ver menu de contexto em [TabBar.tsx](../../src/components/TabBar.tsx) e no explorador).
Selecionar um modo abre o arquivo naquele modo.

## Tarefas

- [ ] Adicionar o item **"Open With…"** ao menu de contexto do arquivo no explorador.
- [ ] Definir um registro de "modos de abertura" (`OpenWithMode`): `id`, `label`, `icon` (codicon do mapa central),
      e um predicado `appliesTo(path): boolean` por tipo/extensão.
- [ ] Registrar os dois modos iniciais: **Editor de Texto** (Monaco) e **Preview de Imagem** (modo existente).
- [ ] Ao acionar "Open With…", listar os modos aplicáveis ao arquivo num seletor (reusar menu de contexto / quick-pick).
- [ ] Marcar o modo **padrão** do tipo (ex.: imagem → Preview; demais → Editor de Texto).
- [ ] Selecionar um modo abre o arquivo nesse modo (texto via [EditorPane](../../src/components/EditorPane.tsx),
      imagem via o componente de preview existente).
- [ ] Manter a arquitetura **extensível**: adicionar um novo modo = registrar uma entrada, sem mexer na UI do seletor.

## Arquivos

- `src/App.tsx` (registro de modos, roteamento da abertura para o modo escolhido, modificado)
- `src/components/EditorPane.tsx` (modo "Editor de Texto", consumido)
- componente de preview de imagem existente (modo "Preview de Imagem", consumido)
- `src/components/TabBar.tsx` ou o componente de menu de contexto reutilizado (item/seletor "Open With…", modificado)
- `src/types.ts` (tipo `OpenWithMode`, modificado)

## Detalhes técnicos

- Modelar os modos como dados (lista de `OpenWithMode`), não como `if/else` espalhados: o seletor apenas
  filtra por `appliesTo(path)` e renderiza as opções com seu codicon (do mapa central de ícones, Fluent 2).
- O preview de imagem já existe (o modo "Open in Images Preview"); aqui só roteamos a abertura para ele
  quando o usuário escolhe esse modo — não reimplementar o preview.
- O modo padrão por tipo deve coincidir com o comportamento de duplo-clique atual (imagens → preview,
  demais → texto), para não surpreender o usuário.
- Reaproveitar o componente de menu de contexto / quick-pick já existente (ver
  [TabBar.tsx](../../src/components/TabBar.tsx)) em vez de criar um seletor novo do zero.
- Acoplamento mínimo: o item só dispara "abrir `path` no modo `id`"; quem sabe renderizar cada modo é o App.

## Critérios de aceite

- [ ] "Open With…" aparece no menu de contexto do arquivo no explorador.
- [ ] O seletor lista apenas os modos aplicáveis ao tipo do arquivo, com o padrão destacado.
- [ ] Escolher "Editor de Texto" abre o arquivo no Monaco; escolher "Preview de Imagem" abre no preview existente.
- [ ] Para um arquivo de imagem, ambos os modos aparecem; para um arquivo de texto, só o editor (e os aplicáveis).
- [ ] Registrar um novo modo não exige alterar a UI do seletor.
- [ ] `tsc --noEmit` sem erros.
