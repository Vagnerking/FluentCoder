# ISSUE-08 · Integração, validação e build

**Épico:** [Fluent VSCode Layout](../EPIC-fluent-vscode-layout.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 01–07

## Contexto

Fechamento do épico: garantir que todas as peças funcionam juntas, sem regressões, e que o
app builda e roda.

## Tarefas

- [ ] `npx tsc --noEmit` sem erros.
- [ ] `cargo check` (e `cargo clippy` se disponível) sem erros/warnings relevantes.
- [ ] Rodar `npm run tauri dev` e validar manualmente o fluxo completo:
  - Abrir pasta → explorer popula.
  - Abrir arquivo → editor + breadcrumbs + status bar refletem.
  - Activity bar troca/colapsa.
  - Terminal abre, roda comandos, resize, fecha sem órfãos.
  - Min/Max/Close e arraste da janela.
  - Mica visível.
- [ ] Verificar que fechar a janela encerra PTYs (sem `powershell.exe` órfão no
      Gerenciador de Tarefas).
- [ ] `npm run tauri build` gera o instalador (`.msi`/`.exe`) sem erro.
- [ ] Atualizar o README do projeto (raiz) com o novo layout e instruções.

## Arquivos

- Vários (validação) + `README.md` na raiz (criar/atualizar).

## Critérios de aceite

- [ ] Checklist de validação manual 100% verde.
- [ ] Build de produção conclui e o app instalado abre.
- [ ] Épico marcado como concluído em [EPIC](../EPIC-fluent-vscode-layout.md).

## Notas

- Se o build de release demorar/falhar por LTO, registrar e seguir — o dev build é o que
  importa para validação funcional.
