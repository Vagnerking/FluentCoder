# Editor — contratos de integração

Este documento registra decisões obrigatórias do editor. Alterações no Monaco,
nos clientes LSP ou no Roslyn devem preservar estes contratos.

## C# / Roslyn: carregamento do projeto e tokens semânticos

### Problema que esta regra evita

O `MonacoLanguageClient` inicia quando o primeiro arquivo C# já pode estar
aberto. Entretanto, o Roslyn só conhece a solution depois da notificação
customizada `solution/open`.

Se tokens semânticos forem solicitados antes de
`workspace/projectInitializationComplete`, o Roslyn pode tratar o documento
como arquivo avulso ou usar um snapshot sem vínculo completo com o projeto.
Isso causa comportamentos como:

- `DateTime` classificado como `variable` em vez de `struct`;
- enums do projeto, como `StatusTituloEnum`, classificados como `variable`;
- classes base, como `AggregateRoot`, classificadas como `variable`;
- tipos perdendo a cor alguns segundos depois de aparecerem corretamente;
- `Ctrl+Click` e outras operações de navegação falhando;
- o contexto aparecer como `Miscellaneous Files`.

O efeito de “começa correto e depois fica branco” normalmente significa que uma
resposta semântica antiga chegou depois e sobrescreveu uma resposta correta.

### Ordem obrigatória de inicialização

O fluxo C# deve seguir esta ordem:

1. Criar e iniciar o `MonacoLanguageClient`.
2. Registrar o provider de tokens semânticos C#, inicialmente desabilitado.
3. Localizar e enviar `solution/open`; usar `project/open` somente quando não
   existir uma solution.
4. Aguardar `workspace/projectInitializationComplete`.
5. Reabrir todos os modelos C# existentes com:
   - `textDocument/didClose`;
   - `textDocument/didOpen`, usando URI, conteúdo e versão atuais do modelo.
6. Habilitar o provider de tokens semânticos.
7. Solicitar um refresh semântico.
8. Descartar respostas de requisições anteriores quando uma requisição mais
   recente já tiver sido iniciada para o mesmo modelo.

Implementação principal:

- `src/lsp/servers/csharp.ts`: abertura da solution e rebind dos documentos;
- `src/lsp/client.ts`: bloqueio inicial do provider e descarte de respostas
  semânticas antigas;
- `src/lsp/uri.ts`: serialização compatível das URIs Windows;
- `src/components/EditorPane.tsx`: cores das categorias semânticas;
- `src/lsp/monacoSetup.ts`: registro e tokenizer léxico do C#.

### Regras que não podem ser removidas

- Não habilitar tokens semânticos C# antes de
  `workspace/projectInitializationComplete`.
- Não substituir o rebind `didClose`/`didOpen` por timeouts.
- Não adicionar checkpoints arbitrários de refresh, como 1, 5, 15 ou 30
  segundos. Eles criam concorrência e podem restaurar classificações antigas.
- Não aceitar uma resposta semântica se outra requisição mais recente já
  começou para o mesmo modelo.
- Não depender somente de `rootUri` ou `workspaceFolder`: o Roslyn utilizado
  pelo app precisa receber `solution/open` ou `project/open`.
- Não alterar a URI Windows de volta para `file:///c%3A/...`. Para o Roslyn, os
  modelos devem ser enviados como `file:///c:/...`.
- Não criar uma segunda instância do Monaco. O editor e o LSP devem compartilhar
  a mesma instância configurada por `src/monaco-loader.ts`.

## Cores: tokens léxicos e semânticos

O destaque C# possui duas camadas:

- O tokenizer Monarch colore sintaxe imediatamente.
- O Roslyn envia tokens semânticos depois e pode sobrescrever a cor lexical.

Portanto, categorias emitidas pelo Roslyn precisam de regras próprias no tema.
Não basta configurar somente scopes como `keyword.if`.

Mapeamentos obrigatórios:

| Categoria Roslyn | Exemplo | Cor esperada |
|---|---|---|
| `class` | `AggregateRoot` | tipo/classe |
| `struct` | `DateTime` | struct |
| `enum` | `StatusTituloEnum` | enum |
| `interface` | interfaces | interface |
| `controlKeyword` | `if`, `return`, `switch` | palavra de controle |
| `keyword` | `var` | palavra-chave |
| `modifier` | `public`, `private`, `static` | modificador |
| `method`, `extensionMethod` | métodos | método |

Se `if` ou `return` começam roxos e depois ficam brancos, falta ou foi removida
a regra semântica `controlKeyword`; o tokenizer não é o problema.

## Critérios mínimos para alterações no pipeline C#

Antes de considerar uma alteração concluída:

1. Abrir uma pasta que contenha `.sln` e múltiplos `.csproj`.
2. Abrir um arquivo C# pertencente a um projeto da solution.
3. Aguardar `workspace/projectInitializationComplete`.
4. Confirmar que `_vs_getProjectContexts` retorna:
   - o projeto correto;
   - `_vs_is_miscellaneous: false`.
5. Confirmar que a classificação final contém, quando presentes:
   - `DateTime` como `struct`;
   - um enum do projeto como `enum`;
   - uma classe base do projeto como `class`;
   - `if` e `return` como `controlKeyword`.
6. Esperar pelo menos mais um refresh do Roslyn e verificar que os tipos não
   voltam para `variable`.
7. Testar `Ctrl+Click` em um tipo definido em outro arquivo.
8. Executar os testes unitários.

Uma validação feita antes da conclusão do carregamento da solution não é
suficiente.

## Diagnóstico rápido

Quando houver regressão:

1. Verificar a URI do modelo. Ela deve usar o formato `file:///c:/...`.
2. Verificar o contexto do documento com
   `textDocument/_vs_getProjectContexts`.
3. Se o contexto for `Miscellaneous Files`, investigar URI, solution e rebind.
4. Se o contexto estiver correto, mas tipos chegarem como `variable`, verificar:
   - se o provider foi habilitado cedo demais;
   - se o `didClose`/`didOpen` ocorreu após a inicialização;
   - se respostas antigas estão sendo descartadas;
   - se existem refreshes temporizados ou providers duplicados.
5. Se a categoria estiver correta no log, mas a cor estiver errada, corrigir o
   tema semântico em `EditorPane.tsx`.

Não corrigir problemas de classificação de tipos apenas alterando cores. A cor
deve refletir a categoria correta fornecida pelo Roslyn.
