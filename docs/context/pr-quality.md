# Qualidade de PRs e segurança

Um incremento só está pronto quando seu comportamento, compatibilidade,
checks e revisão estão demonstrados na base e no SHA publicados. Este contrato
complementa as regras do editor, C#/CSHTML, design e agentes; não as substitui.

## Preparação e escopo

- Trabalhar em uma worktree separada, com base explícita e um objetivo por PR.
  Dividir antes de ultrapassar 100 arquivos, contando locks, fixtures e gerados.
  PRs dependentes apontam para o incremento anterior até sua integração.
- Preservar a branch original e manter um mapa da entrega completa ao dividir
  um PR. Uma divisão por arquivos não comprova incrementos compiláveis: separar
  contratos, registro e consumidores e validar cada estado intermediário.
- Ler os contratos do subsistema. Mapear entrada, validação, efeito externo e
  chamadores; CodeGraph/Serena ajudam a localizar relações, mas não provam
  ausência de chamadas dinâmicas, IPC ou processos externos.
- Escolher critérios de aceite antes da implementação. Testes devem observar
  comportamento ou uma regressão, com controle legítimo pertinente.

## Regras preventivas

- URLs: usar parser e fronteira de hostname ao decidir confiança. Rótulo
  visual não equivale a autorização. Cobrir domínios impostores e remotos SCP.
- Processos: preservar executável e argv quando os campos são dados; shell
  intencional tem outro contrato. Validar argumentos em executável nativo,
  não apenas em função PowerShell que evita o binder real.
- Temporários: criar pastas privadas atomicamente e limpar somente as próprias,
  após encerrar recursos. Preservar caminhos persistentes explícitos. Fixtures
  ficam fora da árvore do código quando herança de ignore/config não é parte
  do cenário; executar testes contra configurações pessoais exige isolamento.
- Dependências: inspecionar manifest, lock, features e consumidores reais.
  Uma feature com o mesmo nome pode escolher outro backend numa versão major.
  Conferir o advisory primário quando divergir da base de audit. Não dispensar
  vulnerabilidades apenas para obter audit verde.
- Segurança: rastrear fonte, controles e sink. Distinguir fixture adversarial,
  diagnóstico de qualidade e caminho de produção, com evidência individual.
  Não sanitizar HTML arbitrário com regex nem excluir diretórios do scanner
  para esconder alertas. Tokens secretos usam CSPRNG.
- Rust/Tauri: propagar erros de entrada, limitar trabalho bloqueante, evitar
  locks sobre await, validar IPC no backend e documentar invariantes de unsafe.
  Usar skills específicas conforme o escopo, preservando edição/MSRV e perfis
  do projeto. Skills não autorizam novos upgrades ou dependências por si só.

## Validação antes da publicação

```sh
npm ci
npm audit --audit-level=high
npm run test:pr-check
npm run test:unit
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D clippy::correctness -D clippy::await_holding_lock
git diff --check
```

Executar também o aceite específico dos caminhos alterados: Roslyn real,
CSHTML/E2E Windows, UI, SSH, extensões ou processos nativos, conforme os
contratos. Testes ignorados e verificações indisponíveis permanecem pendentes.
Não reformatar todo o repositório para esconder dívida histórica de formatação.

Antes de abrir/editar o PR, validar o título e o corpo exatos que serão enviados:

```sh
node scripts/pr-check.mjs --base <base-real> --head <head-real> --event <evento.json>
```

O evento contém `pull_request.title` e `pull_request.body`. Usar Conventional
Commits e as seções `## Descrição` e `## Como testar`, com resultado/evidência;
remover placeholders e `Closes #` vazio. Sem `--event`, o script só confere o
escopo. Ele não é analisador de segurança nem substitui revisão.

O workflow `PR Quality` valida metadados, audit npm, unidades/build do frontend e
testes/Clippy Rust Linux/macOS/Windows. Compilação e execução Rust têm etapas distintas;
a execução tem limite de dez minutos e saída dos testes para diagnóstico.
Timeout é falha, não aprovação. Registrar o último teste/erro antes de alterar
o candidato; não reiniciar jobs apenas porque uma observação expirou.

Se o harness Windows nem iniciar e retornar `STATUS_ENTRYPOINT_NOT_FOUND`,
inspecionar imports/DLLs e manifest. O teste de biblioteca também precisa do
Common Controls v6 quando importa `TaskDialogIndirect`; o manifest padrão Tauri
aplicado apenas aos bins não cobre esse executável. A confirmação exige Windows.

Adicionar workflow não configura ruleset/proteção de branch. Confirmar checks
obrigatórios e revisão efetiva antes de integrar. RTK pode resumir saídas
rotineiras; falhas, diffs e análises de segurança usam os logs completos.

Para cada defeito confirmado, registrar causa, controle legítimo, regressão
antes/depois, regra preventiva e evidências. Um PR corrigido alimenta os checks
e contratos seguintes; instalar ferramentas ou escrever regras não conclui a
correção do produto.
