# Qualidade de PRs e segurança

Este contrato aplica-se a todas as ferramentas de IA do FluentCoder. A meta e
as evidências iniciais estão em [Melhoria contínua](../roadmap/pr-quality.md).

## Antes de implementar

1. Criar uma worktree separada e identificar a base real do trabalho. Manter
   a correção no PR existente e organizar lotes menores para leitura e análise.
   Não abrir PRs auxiliares nem criar workflows, gates ou disparar/reexecutar
   CI sem solicitação explícita do autor. Usar skills e testes locais pertinentes.
2. Ler os contratos em `AGENTS.md` e `CLAUDE.md` e a documentação do subsistema.
   Mapear entrada, validação, efeito externo, chamadores e fronteiras de confiança.
3. Usar CodeGraph para impacto e Serena para símbolos/referências quando
   disponíveis. Ativar explicitamente a worktree atual. Confirmar os resultados
   lendo o código: grafos estáticos não capturam todas as chamadas dinâmicas,
   mensagens IPC ou processos externos.
4. Escrever critérios de aceite e escolher os checks que os demonstram antes
   de mudar o código. Novos testes devem provar comportamento ou regressão;
   não criar testes que apenas copiam a implementação.

## Padrões preventivos aprendidos com o PR #111

- **URLs:** usar um parser e comparar `hostname`, nunca inferir confiança por
  `includes("github.com")`. Para subdomínios permitidos, usar igualdade ou
  fronteira de ponto (`host === dominio || host.endsWith('.' + dominio)`).
  Distinguir rótulo visual de autorização/abertura de URL. Tratar remotos SCP
  (`git@host:path`) explicitamente. Cobrir host impostor, domínio no caminho,
  credenciais, portas e URLs inválidas.
- **Shell e escaping:** definir primeiro o interpretador e o contexto. `cmd`,
  PowerShell, Bash e regex não compartilham regras de escape. Preferir
  executável + lista de argumentos e evitar shell quando possível. Testar
  barras invertidas, aspas, metacaracteres, espaços e múltiplas ocorrências.
  Não recomendar `replaceAll` como solução universal.
- **Aleatoriedade:** tokens, credenciais e identificadores que exigem
  imprevisibilidade usam CSPRNG (`crypto`/`getrandom`), sem fallback para
  `Math.random`. Variáveis aleatórias de snippets são outro caso: rastrear o
  uso antes de declarar um problema de segurança.
- **HTML e regex:** não sanitizar HTML arbitrário com regex. Usar renderização
  textual ou sanitizador apropriado. Não executar regex adversarial sem limites;
  fixtures intencionalmente maliciosas devem provar a rejeição com segurança.
- **Rust:** propagar erros recuperáveis com contexto, evitar panic/unwrap em
  entradas externas, não manter guardas de lock através de `.await`, limitar
  trabalho bloqueante no runtime async e encerrar processos/tarefas no teardown.
  Documentar invariantes de `unsafe`; respeitar edição 2021 e toolchain efetiva.
- **Tauri:** tratar IPC como entrada não confiável; validar caminhos e escopos
  no backend, restringir capabilities/CSP por janela, verificar origem e
  autenticação de bridges e não expor segredos em logs. Consultar o contrato
  local de extensões antes de alterar host/sidecars. Tipagem TypeScript não
  substitui validação Rust em runtime.
- **Dependências:** manter manifests e lockfiles coerentes, verificar avisos
  antes/depois e testar o caminho afetado por overrides. Não esconder alertas
  ou remover testes para obter checks verdes.

## Ferramentas e skills

As skills foram instaladas no usuário, em `~/.codex/skills/`, não como
arquivos do produto. Estão disponíveis para descoberta a partir do próximo
turno. A instalação foi fixada nos commits abaixo; upgrades exigem nova revisão.

| Origem | Commit | Skills |
|---|---|---|
| [leonardomso/rust-skills](https://github.com/leonardomso/rust-skills) | `fd2a861ab0406a4ac536a55274d14ea6fd1ca9c9` | `rust-skills` |
| [full-stack-skills/tauri-skills](https://github.com/full-stack-skills/tauri-skills) | `77b57c4913873a0f8cab7db45116038dc18a27f0` | `tauri-security`, `tauri-framework-security`, `tauri-ipc` |
| [openai/skills](https://github.com/openai/skills) | `49f948faa9258a0c61caceaf225e179651397431` | `security-best-practices`, `gh-address-comments`, `gh-fix-ci` |

`security-best-practices` cobre JS/TS, Python e Go; não é uma skill de Rust.
Para Rust/Tauri, usar as skills específicas e documentação oficial. O plugin
Codex Security já disponível oferece triagem, análise de diff e validação;
carregar a skill correspondente à tarefa antes de usar seu workflow.
Regras locais e autorização do usuário prevalecem sobre recomendações genéricas
(por exemplo, não copiar perfis Cargo de uma skill para este app).

CodeGraph 1.6.2 e Serena 2.1.0 já estavam instalados. Foram registrados como MCPs
no `~/.codex/config.toml`. Uma nova sessão precisa carregar esses servidores;
o registro não significa que as ferramentas apareceram na sessão corrente.
O CodeGraph registrado usa o launcher nativo do pacote instalado, com runtime
embutido, para não depender do PATH temporário do fnm. Se mover/remover o
pacote, atualizar o caminho do servidor. Serena inicia sem projeto fixo:
ativar o caminho correto antes das consultas, especialmente no app desktop.

Exemplo de uso local (substituir o caminho pela worktree efetiva):

```sh
codegraph init --yes /caminho/da/worktree
codegraph sync /caminho/da/worktree
codegraph query shellQuote --path /caminho/da/worktree
codegraph impact shellQuote --path /caminho/da/worktree
serena project create --name FluentCoder --language rust --language typescript /caminho/da/worktree
serena project health-check /caminho/da/worktree
```

`project create` é necessário apenas na primeira configuração da worktree.
Os índices e logs ficam ignorados pelo Git. Após o usuário esclarecer “RTK ou RKT”, foi identificado o **RTK (Rust Token
Killer)** já instalado em `~/.local/bin/rtk`, versão 1.0.1. Sua função é resumir
saídas de comandos para reduzir ruído no contexto; não é analisador de segurança
nem grafo de dependências. Origem/documentação:
[rtk-ai/rtk](https://github.com/rtk-ai/rtk) e
[instalação oficial](https://www.rtk-ai.app/docs/getting-started/installation/).

Usar explicitamente em comandos rotineiros, por exemplo `rtk git status` e
`rtk test npm run test:pr-check`; ambos foram exercitados nesta worktree.
O segundo executou os quatro testes do gate com código de saída zero. Para
falhas, alertas ou revisão de segurança, consultar o comando original e os logs
completos. Não usar saída resumida como evidência de ausência de problemas nem
ocultar diffs da revisão. O CI mantém comandos originais e não depende do RTK.
Não foi necessário reinstalar o binário ou ativar hooks globais para este uso.

## Antes de abrir ou atualizar PR

```sh
npm ci
npm run test:unit
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D clippy::correctness -D clippy::await_holding_lock
git diff --check
```

Escolher os comandos locais conforme o caminho alterado. Não executar toda
esta lista repetidamente para mudanças que não afetam o comportamento testado.
Não criar nem disparar CI de qualidade para esta meta; preservar as automações
preexistentes do projeto. Skills de análise e revisão não exigem GitHub Actions.

Executar `cargo fmt --check` para avaliar formatação Rust; dívida histórica deve
ser tratada separadamente, sem reformatar o repositório inteiro em um PR de
feature. A política inicial de Clippy bloqueia correctness e lock sobre await,
sem transformar toda advertência histórica em erro. Adicionar novas categorias
após medir e eliminar sua dívida em PR próprio.

Quando há mudança de feature, executar também o aceite específico: UI real,
E2E em plataforma suportada, Roslyn real, CSHTML, SSH ou host de extensões
conforme os contratos. Checks unitários verdes não demonstram esses aceites.

A descrição deve informar problema, resultado, riscos, comandos executados e
resultados. Usar título Conventional Commits. Não enviar template vazio nem
`Closes #` sem número. Revisar o diff completo, incluindo locks e arquivos
ignorados pelo bot, e verificar alertas contra o SHA atual.

## Ciclo de aprendizado

Para cada alerta: registrar fonte/SHA, entrada e destino, pré-condições,
impacto demonstrado e decisão. Separar defeito confirmado, falso positivo
justificado e pendência de investigação. Para defeitos, acrescentar teste de
regressão que falhe antes e passe depois, mais uma regra preventiva adequada.
Não resolver threads nem dispensar alertas sem evidência.

A cada PR, registrar arquivos alterados, revisão executada/pulada, defeitos
confirmados, recorrências e checks executados/bloqueados. Após cinco PRs,
comparar com a linha de base do #111 e ajustar regras com base nos resultados.
Esse aprendizado persiste nos contratos e checks do repositório; não altera
os pesos do modelo nem garante ausência de novos defeitos.
