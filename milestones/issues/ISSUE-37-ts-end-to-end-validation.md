# ISSUE-37 · Full: validação E2E do IntelliSense TypeScript/JavaScript

**Épico:** [TypeScript e JavaScript — IntelliSense via LSP real](../EPIC-lsp-typescript-javascript.md) · **Camada:** Full · **Tamanho:** S · **Depende de:** 35, 36, 33

## Contexto

Com o client TS/JS configurado e o worker embutido desabilitado, esta issue valida a experiência
completa em um projeto real — este próprio repositório (React+Vite+TypeScript) — e garante que
não há diagnósticos duplicados, IntelliSense competindo nem regressões nos outros tipos de arquivo.

## Tarefas

- [ ] Abrir este repositório no editor e validar manualmente:
      - **Completions:** digitar `useState` em um `.tsx` → sugestão + import automático.
      - **Hover:** passar o mouse sobre `invoke` de `@tauri-apps/api` → tooltip com tipo correto.
      - **Diagnósticos:** introduzir erro de tipo temporário → aparece com underline + ProblemsPanel.
      - **Go-to-definition (F12):** em uma importação → navega para o arquivo correto.
      - **Find References (Shift+F12):** em uma função → lista todas as ocorrências.
      - **Rename (F2):** renomear um símbolo local → atualiza todas as referências.
      - **Format (Ctrl+K Ctrl+F):** formata arquivo `.ts` sem erros.
      - **Organize Imports:** Code Action "Organize Imports" funciona.
- [ ] Confirmar zero diagnósticos duplicados (worker embutido desabilitado corretamente).
- [x] Confirmar que arquivos `.cs` e `.cshtml` não são afetados (sem regressão).
- [ ] Escrever teste E2E (tauri-driver) cobrindo:
      - Abrir workspace deste repositório.
      - Aguardar o servidor TS ficar pronto (status bar "Pronto").
      - Abrir um arquivo `.ts`.
      - Verificar que o ProblemsPanel não tem erros falsos.
- [x] `tsc --noEmit` e `cargo check` sem erros.

## Arquivos

- `tests/e2e/specs/` (adicionar spec de IntelliSense TS)
- Nenhum arquivo de implementação — esta issue é só validação.

## Detalhes técnicos

- O teste E2E deve usar `tauri build` + tauri-driver (não Playwright/MCP) — conforme regra do projeto.
- Se algum recurso não funcionar conforme esperado, abrir sub-issue ou atualizar a ISSUE-35
  com o fix antes de marcar esta como concluída.
- "Zero diagnósticos duplicados" pode ser verificado desabilitando o `typescript-language-server`
  temporariamente e confirmando que **nenhum** diagnóstico aparece (worker desabilitado na 33).

## Critérios de aceite

- [ ] Todos os recursos listados nas Tarefas funcionam neste repositório.
- [ ] Zero diagnósticos duplicados confirmado.
- [x] Nenhuma regressão em `.cs`, `.cshtml` nem outros tipos de arquivo.
- [ ] Teste E2E tauri-driver passa.
- [x] `tsc --noEmit` e `cargo check` sem erros.
- [x] Épico TypeScript/JavaScript marcado como Concluído no README de milestones.
