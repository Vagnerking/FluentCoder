# Meta: PRs revisáveis e redução de erros recorrentes

Criada em 28/10/2026 a pedido do usuário, a partir do
[PR #111](https://github.com/Vagnerking/FluentCoder/pull/111).
Contrato de execução: [Qualidade de PRs e segurança](../context/pr-quality.md).

## Linha de base observada

Snapshot: head `8926d91274707404ecf4374e853ea0679c66c6dd`, base
`c965a78968152c9e756fe0e5907fed7b3532fd21`.

- 82 commits; 647 arquivos; 126.058 adições e 12.705 remoções, segundo a API.
- Título `Feat/git fluent workspace polish`, fora do padrão pedido pelo template.
- Descrição ainda contendo o template vazio, inclusive `Closes #`.
- CodeRabbit pulou a revisão: 637 arquivos elegíveis, limite informado de 100.
  A diferença de dez arquivos corresponde aos filtros do revisor.
- 13 comentários inline do CodeQL. São alertas, não 13 vulnerabilidades
  confirmadas; alguns estão em testes.
- O connector não retornou workflow runs de PR para o SHA consultado.
  A CLI `gh` local estava sem autenticação. Isso não prova que todos os checks
  estejam ausentes ou verdes. O workflow versionado existente publica releases
  após push na main; não continha testes de PR.

## Inventário dos alertas (triagem ainda pendente)

| IDs CodeQL | Arquivo | Categoria e investigação necessária |
|---|---|---|
| [9](https://github.com/Vagnerking/FluentCoder/security/code-scanning/9), [10](https://github.com/Vagnerking/FluentCoder/security/code-scanning/10), [11](https://github.com/Vagnerking/FluentCoder/security/code-scanning/11) | `src/components/git/GitFluentRemotesView.tsx` | `includes` identifica provedor; confirmar impacto visual versus decisão de confiança e usar hostname canônico. |
| [13](https://github.com/Vagnerking/FluentCoder/security/code-scanning/13), [14](https://github.com/Vagnerking/FluentCoder/security/code-scanning/14) | `src/git/graphModel.ts` | `endsWith` sem fronteira de domínio; rastrear construção/abertura do link Azure. |
| [8](https://github.com/Vagnerking/FluentCoder/security/code-scanning/8) | `src/editor/snippets/snippetService.ts` | UUID com fallback `Math.random`; verificar consumidor e exigência de imprevisibilidade. |
| [3](https://github.com/Vagnerking/FluentCoder/security/code-scanning/3) | `src/settings/vscodeCompat.ts` | Escape de shell; verificar comportamento em cada interpretador e caminhos Windows. |
| [4](https://github.com/Vagnerking/FluentCoder/security/code-scanning/4) | `tools/ext-host/discovery/static-scan.js` | Escape de nome interpolado em regex; verificar origem dos nomes e metacaracteres. |
| [15](https://github.com/Vagnerking/FluentCoder/security/code-scanning/15) | `src/editor/textmate/textmate.test.ts` | Regex adversarial em teste; confirmar que apenas testa rejeição e não executa backtracking sem limite. |
| [12](https://github.com/Vagnerking/FluentCoder/security/code-scanning/12) | `src/git/avatars.test.ts` | Domínio em fixture; avaliar a implementação exercitada, não apenas o literal. |
| [5](https://github.com/Vagnerking/FluentCoder/security/code-scanning/5) | `tools/ext-host/test/integration.test.js` | `replace` em expectativa literal de URI; verificar se há decodificação insegura no caminho real. |
| [6](https://github.com/Vagnerking/FluentCoder/security/code-scanning/6), [7](https://github.com/Vagnerking/FluentCoder/security/code-scanning/7) | `tools/ext-host/test/shim.test.js` | Regex HTML em teste; rastrear sanitização real e cobertura de tags/atributos adversariais. |

Este inventário não constitui auditoria completa e não encerra nenhum alerta.
Corrigir os achados do #111 é uma etapa posterior de triagem e patches focados;
esta entrega trata da prevenção, ferramentas e gates de qualidade solicitados.

## Critérios mensuráveis

| Prazo/escopo | Aceite |
|---|---|
| Preparação local desta meta | Skills instaladas com origem/commit; CodeGraph consultado; health check Serena aprovado; contratos e checks em worktree separada. |
| Antes de publicar as mudanças | Testes do gate aprovados, resultados de build/unidades/Rust registrados; limitações explícitas. |
| Antes de integrar qualquer PR | Um objetivo, até 100 arquivos, descrição preenchida, checks aplicáveis e alertas triados; nenhum defeito confirmado de risco alto/crítico pendente. |
| Próximos cinco PRs | 100% com evidência de validação e revisão executada; zero revisão pulada por tamanho; zero recorrência de defeito confirmado já coberto por regressão. |
| Após cinco PRs | Registrar quantidade de defeitos e recorrências, comparar à linha de base e ajustar regras. Não prometer zero alertas: fixtures e falsos positivos exigem justificativa. |

## Etapas

- [x] Consultar metadados e comentários do PR e registrar a linha de base.
- [x] Instalar skills de Rust, Tauri, segurança JS/TS e manutenção de PRs.
- [x] Registrar CodeGraph/Serena no Codex e exercitar ferramentas locais.
- [x] Criar contrato persistente em AGENTS/CLAUDE e gate de revisabilidade com testes.
- [x] Preparar workflow de validação de PR; execução remota depende de publicação.
- [ ] Triar os 13 alertas com evidências e corrigir os defeitos confirmados.
- [ ] Dividir/reorganizar o #111 em incrementos revisáveis e preencher sua descrição.
- [ ] Publicar e observar o workflow; configurar checks obrigatórios no ruleset adequado.
- [ ] Identificar qual ferramenta o usuário chama de SKT antes de instalar/configurar.
- [ ] Medir os cinco próximos PRs e registrar o primeiro balanço.

Não reescrever nem dividir a branch publicada automaticamente: a reorganização
precisa preservar as dependências e o trabalho já publicado. Manter esta
preparação na branch `chore/pr-quality-guardrails` até a integração validada.

## Validação da preparação em 28/10/2026

- `npm ci`: concluído na worktree com o lock existente.
- `npm run test:pr-check`: 4/4 aprovados, cobrindo o limite, template vazio,
  opções inválidas, merge-base, trabalho local e nomes de arquivo incomuns.
- `pr:check --base HEAD`: 9 arquivos desta preparação, aprovado. Aplicado ao
  intervalo original do #111: rejeitou corretamente os 647 arquivos.
- `npm run test:unit`: 1.086 aprovados, nenhuma falha ou teste ignorado.
- `npm run build`: aprovado; avisos existentes de CSS vazio e chunks grandes.
- `cargo test --locked --lib`: 405 aprovados e 12 ignorados no Linux. Ignorados
  não contam como validação executada.
- `cargo clippy --locked --all-targets -- -D clippy::correctness -D clippy::await_holding_lock`:
  aprovado; ainda há advertências fora das categorias bloqueantes.
- CodeGraph: 679 arquivos, 15.550 nós e 43.270 arestas; consulta ao
  `remoteProviderLabel` e análise de impacto de `shellQuote` executadas.
  Uma fixture C# gerada produziu aviso de parsing, portanto o grafo não é
  completo para aquele arquivo.
- Serena: health check de Rust/TypeScript aprovado, incluindo descoberta de
  símbolos e referências. Handshake MCP `initialize` aprovado para ambos os
  servidores; configurações registradas no Codex.
- `npm audit --json`: 52 entradas reportadas (43 baixas, 2 moderadas, 6 altas,
  1 crítica), incluindo `dompurify`. Isso é dívida de dependências a triar,
  não contagem de explorações confirmadas. Não foi usado `audit fix --force`.
- `git diff --check`: aprovado.

O workflow novo ainda não foi executado no GitHub. Os checks Windows, E2E,
aceites interativos e uma auditoria completa não foram executados nesta
preparação. Não há alteração de código de runtime nesta entrega. Os alertas
CodeQL e a dívida de dependências continuam pendentes; esta preparação não
certifica o #111 para merge.
