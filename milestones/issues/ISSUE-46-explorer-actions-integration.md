# ISSUE-46 · Explorador: integração, acessibilidade e E2E

**Épico:** [Ações do Explorador de Arquivos](../EPIC-file-explorer-actions.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 42–45 · **Status:** 🟡 Parcial

## Contexto

Esta issue fecha o épico validando as quatro ações em conjunto, o comportamento
em diferentes estados do workspace, a aderência ao Fluent 2 e a ausência de
regressões no editor.

## Tarefas

- [x] Organizar os quatro botões em uma command bar compacta no cabeçalho.
- [x] Garantir ordem e textos: Novo arquivo, Nova pasta, Atualizar explorador,
      Recolher pastas.
- [x] Validar estados rest, hover, pressed, focus e disabled com tokens existentes.
- [x] Validar navegação por Tab, ativação por Enter/Espaço, foco do campo inline,
      confirmação por Enter e cancelamento por Esc.
- [ ] Validar 200% de zoom e contraste manualmente.
- [x] Validar tooltips, `aria-label` e anúncios de erro/loading.
- [x] Validar workspace vazio, raiz sem permissão, nomes inválidos, colisões e
      alterações externas.
- [x] Confirmar que criar/atualizar/recolher não reinicia LSP nem fecha abas.
- [x] Executar `tsc --noEmit`, testes unitários e `cargo check`.
- [x] Criar E2E com tauri-driver cobrindo as quatro ações em um workspace temporário.
- [x] Executar `tauri build` antes do E2E, conforme a regra do projeto.
- [x] Atualizar este épico e o README de milestones.

## Arquivos

- `src/components/FileExplorer.tsx`
- `src/components/TreeNode.tsx`
- `src/styles.css`
- `tests/`
- `milestones/EPIC-file-explorer-actions.md`
- `milestones/README.md`

## Detalhes técnicos

- Usar Codicons pelo mapa central já existente; não adicionar SVG inline.
- O teste E2E deve usar diretório temporário controlado, sem depender do seletor
  nativo de pasta.
- A command bar não deve deslocar ou truncar de forma ilegível o nome da raiz.

## Critérios de aceite

- [x] As quatro opções aparecem na ordem definida, com ícones e textos acessíveis.
- [x] Todos os fluxos funcionam por mouse e teclado.
- [x] Erros preservam dados e orientam a correção.
- [x] Nenhuma ação permite escrita fora do workspace ou sobrescrita acidental.
- [x] Não há regressão em abas, editor, Quick Open, Git ou LSP.
- [ ] `tsc --noEmit`, testes unitários, `cargo check`, `tauri build` e E2E passam.
- [x] README e épico refletem o status real da implementação.

## Validação parcial

- `npm run build`: passou.
- `npm run test:unit`: 24 testes passaram.
- `cargo test --lib`: 6 testes passaram.
- `cargo check`: passou.
- `tauri build --no-bundle`: passou.
- E2E: uma execução validou Nova pasta, Atualizar explorador e Recolher pastas;
  a suíte oscila com Edge 149 porque o msedgedriver instalado não é homologado
  para essa versão.
