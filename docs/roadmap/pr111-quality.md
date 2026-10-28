# Meta ativa: corrigir e preparar o PR #111 para integração

Criada em 28/10/2026 a pedido do usuário.
Alvo: [PR #111](https://github.com/Vagnerking/FluentCoder/pull/111).
Status: **em andamento; PR ainda não aprovado para integração**.

## Resultado esperado

Entregar as mudanças do #111 em incrementos revisáveis, com os defeitos
confirmados corrigidos, alertas decididos com evidência, dependências avaliadas
e validação dos caminhos reais afetados. A meta só termina quando os critérios
de conclusão abaixo estiverem demonstrados no estado final publicado.
Instalar ferramentas, escrever regras ou obter somente build verde não basta.

Contrato: [Qualidade de PRs e segurança](../context/pr-quality.md).
Histórico e evidências iniciais: [Melhoria contínua](pr-quality.md).
Os números abaixo são snapshots locais; atualizar SHA e estado remoto antes
de publicar correções ou declarar conclusão.

## Ponto de partida

- PR observado em `8926d91`: 82 commits, 647 arquivos e revisão CodeRabbit
  pulada pelo tamanho; título/descrição sem o preenchimento esperado.
- Treze alertas CodeQL triados localmente: dez sem vulnerabilidade demonstrada
  no caminho reportado, dois Azure ainda pendentes de conclusão e um defeito
  confirmado de reinterpretação de argumentos no PowerShell. Isso não equivale
  a dispensar os alertas no GitHub.
- Audit inicial: 52 entradas, incluindo uma crítica e seis altas; alcance real
  e versões corrigidas ainda precisam ser estabelecidos por dependência.
- Preparação de qualidade: branch `chore/pr-quality-guardrails`, worktree
  `FluentCoder-pr-quality`; skills, regras, check de PR e workflow preparados.
- Candidato inicial de argumentos: commit WIP `f2de524`, cuja regressão do
  binder nativo falhava. Foi substituído pelo plano estruturado descrito no
  registro abaixo; o candidato atual continua em rascunho até os aceites.

## Estado mais recente em 28/10/2026

- #112 atualizado em `3f416ce487bd069f4c109a864c549124cca10ad4` para
  diagnosticar a falha Windows `STATUS_ENTRYPOINT_NOT_FOUND`, que aconteceu
  antes dos testes. Novo run
  [40767926784](https://github.com/Vagnerking/FluentCoder/actions/runs/40767926784):
  Linux/frontend/metadados passaram; Windows em execução neste snapshot.
- #113 atualizado em `91a3f824fce4ea462a8d737058f5f6c5019d6400` com teste
  de fechamento da árvore nativa e mais casos `.cmd`/`.bat`. O fechamento pelo
  caminho real de sessão passou localmente no Linux; batch/Windows pendentes.
  A suíte padrão continua com 408 aprovados, agora 14 ignorados; os dois
  aceites explícitos de PTY foram executados separadamente no Linux. Novo
  run [40767982197](https://github.com/Vagnerking/FluentCoder/actions/runs/40767982197):
  frontend/metadados/argumentos PowerShell passaram; Rust em execução.
- [PR #114: correções npm](https://github.com/Vagnerking/FluentCoder/pull/114),
  rascunho com três arquivos, base `ci/pr111-quality-gates`, head
  `d3a8ffbab657ada6c6d54f2a18f373bc9bd50694`. Audit local passou de 52 entradas
  para zero com atualizações compatíveis; adiciona audit ao CI. Instalação
  limpa, 1086 testes frontend, quatro testes do gate e build passaram.
  Sanitizador e renderer Markdown reais do Codingame passaram no WebKitGTK
  antes/depois, preservando formatação/links e rejeitando os casos maliciosos.
  Revisão independente não encontrou defeitos concretos; aguardar CI remoto.
- O primeiro inventário Cargo encontrou 20 advisories, além de avisos de
  manutenção/unsoundness/yanked. Alcance e remediação ainda pendentes; nenhum
  arquivo Cargo foi alterado no incremento npm. Npm limpo não equivale a
  segurança integral aprovada.
- Evidências e fixtures foram salvas nas coleções gerenciadas das worktrees.
  O #111 e a `main` continuam preservados; meta ativa, sem aceite antecipado.

## Snapshot anterior de 28/10/2026

- Meta registrada e ativa. Skills de Rust/Tauri/segurança instaladas e regras
  preventivas compartilhadas entre ferramentas em `AGENTS.md`/`CLAUDE.md`.
- [PR #112: verificações de qualidade](https://github.com/Vagnerking/FluentCoder/pull/112),
  rascunho com dez arquivos, base `feat/git-fluent-workspace-polish`, head
  `582d7c3e3f59c38c46f16dc3b500daea52f45902`. O workflow
  [40765021812](https://github.com/Vagnerking/FluentCoder/actions/runs/40765021812)
  passou em escopo/metadados e frontend; Rust Linux/Windows ainda em execução
  neste snapshot.
- [PR #113: execução estruturada de tarefas](https://github.com/Vagnerking/FluentCoder/pull/113),
  rascunho com 16 arquivos, base `ci/pr111-quality-gates`, head
  `3bb80a5251240edca021f9d4817a915a3cd85a1c`. `process` e launch mantêm
  executável/argv separados até o backend; `shell` mantém código intencional.
  O workflow [40766284779](https://github.com/Vagnerking/FluentCoder/actions/runs/40766284779)
  passou em escopo/metadados, frontend e argumentos no PowerShell 7/Windows
  PowerShell. Os jobs Rust e aceites do aplicativo real seguem pendentes.
- Validação local do candidato: 1098 testes frontend aprovados; 408 testes
  Rust aprovados e 13 ignorados no conjunto padrão. O aceite explícito do
  app Linux em PTY passou separadamente, incluindo argv, stdin da tarefa,
  Ctrl+C e retorno ao perfil. Build frontend/app e os gates de Clippy passaram.
  Typecheck isolado Windows passou; isso não comprova execução GUI/ConPTY.
- Houve investigação e revisão independentes da fronteira de execução. O
  candidato trata o problema apontado de stdio no executável GUI Windows;
  a confirmação no app release ainda depende do CI. Continuam necessários
  aceite de `.cmd`/`.bat`, teardown durante tarefa e fluxo real pela UI.
- O primeiro check de shell Windows detectou caminhos curtos (`RUNNER~1`)
  versus longos. O teste compara agora identidade de diretório (`dev`/`ino`)
  e continua verificando os argumentos completos; passou no novo head.
- O #111 e a `main` permanecem inalterados. Os 13 alertas, dependências e a
  divisão do restante do diff continuam no escopo; estes dois rascunhos não
  representam aceite do PR original. Reconsultar os checks no SHA final.

## Ordem de execução e critérios de aceite

### 1. Fechar a fronteira de execução das tarefas

- [ ] Separar executável/argv de `process` e código intencional de `shell` até
  a fronteira real de execução, sem reconstruir dados como comandos inseguros.
- [ ] Fazer passar o teste que hoje falha com `--%`, espaços e expansão de
  variável de ambiente no binder nativo.
- [ ] Demonstrar que argumentos chegam intactos em programas nativos, além
  de funções PowerShell usadas como controles. Cobrir vazio, aspas ASCII e
  Unicode, barras finais, `$()`, `@args`, CR/LF e metacaracteres.
- [ ] Validar PowerShell 7 e Windows PowerShell 5.1 no Windows, e os caminhos
  POSIX suportados. Validar o comportamento definido para `.cmd`/`.bat` com
  casos adversariais e controles legítimos; limitações precisam ser explícitas,
  sem aceitação insegura ou alteração silenciosa de argumentos.
- [ ] Preservar `cwd`, `program`, `projectPath`, variáveis, dependências de
  tarefas, `preLaunchTask` e comandos shell intencionais. Conferir perfis de
  terminal configurados e registrar o defeito já observado nesse caminho.
- [ ] Executar a revisão independente exigida pela skill de correção e
  resolver bypasses/regressões confirmados antes de promover o candidato.

### 2. Concluir os alertas do PR

- [ ] Atualizar os alertas contra o SHA atual e manter uma decisão individual
  para cada um dos treze alertas originais e quaisquer novos alertas relevantes.
- [ ] Resolver os defeitos de reconhecimento de domínio Azure, com fronteira
  de hostname correta e testes para hosts impostores e remotos legítimos.
- [ ] Para cada defeito confirmado: evidência antes/depois, teste pertinente e
  revisão dos chamadores e representações alternativas.
- [ ] Para cada alerta não acionável: justificativa de alcance/controle com
  referências de código; preservar fixtures adversariais e testes úteis.
  Não excluir diretórios inteiros nem desativar regras para silenciar o scanner.
- [ ] Reexecutar o CodeQL no estado corrigido. Nenhum defeito confirmado fica
  pendente; alertas restantes precisam de decisão justificada e revisável.

### 3. Tratar dependências com validação de compatibilidade

- [ ] Atualizar o inventário npm/Cargo, identificando pacote, advisory, versão,
  caminho transitivo e uso em runtime/build/teste; distinguir alertas repetidos
  na árvore de problemas independentes.
- [ ] Priorizar a entrada crítica de DOMPurify e as altas; corrigir as versões
  afetadas e alcançáveis ou demonstrar não aplicabilidade com evidência.
- [ ] Manter manifests e lockfiles coerentes e executar instalação limpa.
  Validar o caminho real afetado por cada upgrade/override, especialmente
  Monaco, extensões e Tauri. Não usar `audit fix --force` sem analisar o diff.
- [ ] Não deixar vulnerabilidade crítica/alta confirmada e alcançável sem
  remediação. Pendência de evidência impede o aceite desse item.
- [ ] Registrar a decisão das entradas moderadas/baixas; correções necessárias
  ao #111 entram no escopo, dívida não bloqueante fica identificada com motivo
  e acompanhamento, sem ser omitida do resultado.

### 4. Organizar e validar a entrega

- [ ] Atualizar a relação base/head do #111 e mapear os 82 commits por objetivo
  e dependência antes de decidir como dividir a entrega.
- [ ] Preparar incrementos de até 100 arquivos, contando locks e fixtures, sem
  ocultar mudanças do revisor. PRs dependentes precisam de base explícita.
- [ ] Preservar o trabalho publicado. Preparar uma divisão revisável antes de
  qualquer reescrita da branch remota; não executar force-push como rotina.
- [ ] Preencher título, problema, comportamento resultante, riscos, comandos
  e resultados reais. Remover placeholders e relacionar issues corretas.
- [ ] Executar os checks locais aplicáveis: check de PR, unidades, build,
  testes/Clippy Rust quando afetados e verificações de dependências.
- [ ] Executar aceites específicos do escopo: Windows/Linux, E2E e interfaces
  reais; Roslyn/CSHTML/SSH/extensões quando os caminhos correspondentes mudarem.
  Registrar testes ignorados e impedimentos sem contá-los como aprovados.
- [ ] Publicar a entrega validada e observar os checks no GitHub contra o SHA
  final. Confirmar revisão efetivamente executada, sem salto por tamanho.
- [ ] Verificar os checks obrigatórios e proteção/ruleset aplicáveis. Não
  confundir workflow versionado com proteção de branch já configurada.

## Definição de concluído

Todos estes itens precisam ser verdadeiros ao mesmo tempo:

1. Não existe teste de regressão relevante falhando nem validação obrigatória
   pendente nos caminhos alterados.
2. Os alertas foram decididos individualmente; os defeitos confirmados estão
   corrigidos e nenhuma vulnerabilidade crítica/alta confirmada e alcançável
   permanece no escopo da entrega.
3. Os incrementos são revisáveis, têm descrição completa e receberam revisão
   efetiva; correções solicitadas na revisão foram atendidas.
4. Os checks aplicáveis passaram no SHA final publicado, com evidências de
   runtime/plataforma quando exigidas pelos contratos do projeto.
5. O diff final respeita os contratos do editor, preserva compatibilidade e
   não contém segredos, estado local ou artefatos indevidos.

Somente então declarar o #111 e seus incrementos prontos para integração.
A meta não autoriza antecipar esse aceite nem integrar candidatos WIP na main.

## Registro por incremento

Registrar: objetivo; branch/worktree; base/head; arquivos; alertas tratados;
causa e regra preventiva; regressões antes/depois; comandos e resultados;
aceites de plataforma; revisão; riscos/limitações; próxima ação concreta.
Usar CodeGraph/Serena para contexto e RTK para saídas rotineiras, preservando
logs completos de diagnóstico e segurança. Evidências de segurança ficam na
coleção gerenciada do Codex Security; este roadmap acompanha a execução.

Após integrar, medir os cinco PRs seguintes conforme a meta de melhoria
contínua. Esse acompanhamento posterior não substitui nem prolonga os
critérios de conclusão específicos do #111.
