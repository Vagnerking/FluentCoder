# ISSUE-28 · Full: UX de status dos servidores LSP na StatusBar

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Full · **Tamanho:** S · **Depende de:** 27

## Contexto

Sem feedback visual, o usuário não sabe se o Language Server está baixando, iniciando, pronto ou
com falha — o editor parece "não funcionar" durante a inicialização. Esta issue adiciona um
indicador discreto de status na [StatusBar.tsx](../../src/components/StatusBar.tsx) e trata os
erros mais comuns (`.NET SDK` ausente, download falhou, servidor crashou).

## Tarefas

- [x] Em [StatusBar.tsx](../../src/components/StatusBar.tsx), adicionar um item de status LSP:
      - Ícone + texto: `{ }` C# · Baixando… / Iniciando… / Pronto / Erro.
      - Recebe `lspStatus: Map<string, 'starting' | 'downloading' | 'ready' | 'error'>` como prop.
      - Ao clicar em "Erro", abre um toast/dialog com a mensagem de erro e, se aplicável, link
        para instalação do .NET SDK.
- [x] Em [App.tsx](../../src/App.tsx):
      - Passar `lspStatus` do hook `useLspManager` para a `StatusBar`.
      - Escutar o evento Tauri `"lsp-download-progress"` (emitido pela ISSUE-26) e atualizar
        o status para `'downloading'` durante o download.
- [x] Adicionar estado `'downloading'` ao hook `useLspManager` (ISSUE-25): ao chamar `startLspServer`,
      antes do servidor estar pronto, o status fica `'downloading'` ou `'starting'`.
- [x] Tratar erros conhecidos com mensagens amigáveis:
      - `.NET SDK não encontrado` → "Para usar IntelliSense C#, instale o .NET SDK."
      - Falha de download → "Não foi possível baixar o servidor C#. Verifique a conexão."
      - Servidor encerrou inesperadamente → "Servidor C# encerrou. Clique para reiniciar."
- [x] Ação de **reiniciar** o servidor no clique do item de erro.

## Arquivos

- `src/components/StatusBar.tsx` (adicionar item LSP status)
- `src/App.tsx` (passar status + escutar evento download)
- `src/lsp/useLspManager.ts` (adicionar estado 'downloading')
- `src/styles.css` (estilo do item LSP na status bar, mínimo)

## Detalhes técnicos

- O item de status deve ser discreto: um pequeno ícone `{ }` (ou similar) com o nome da linguagem e
  o estado. Não ocupar espaço desnecessário quando pronto.
- Múltiplos servidores (C# + TS) podem estar ativos simultaneamente — o status mostra o "pior" estado
  (se um está em erro, o item fica em erro; se todos prontos, mostra pronto).
- Estilo Fluent Design, consistente com os demais itens da StatusBar.

## Critérios de aceite

- [x] StatusBar mostra "Baixando…" enquanto o Roslyn está sendo baixado.
- [x] StatusBar mostra "Iniciando…" enquanto o servidor está subindo.
- [x] StatusBar mostra "C# Pronto" quando o servidor está ativo.
- [x] StatusBar mostra "C# Erro" com mensagem descritiva em caso de falha.
- [x] Clicar em "Erro" exibe a mensagem completa e instrução de instalação do .NET SDK se aplicável.
- [x] Ação de restart no estado de erro funciona.
- [x] `tsc --noEmit` sem erros.
