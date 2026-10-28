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
- Candidato de argumentos: branch `fix/vscode-task-arguments`, worktree
  `FluentCoder-task-arguments`, commit WIP `f2de524`. A regressão do binder
  nativo ainda falha: **não publicar esse candidato como correção concluída**.

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
