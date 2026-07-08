# Fluent Workspaces

Status: arquitetura definida e Fase 1 parcialmente implementada.

Implementado no estado atual:

- parser/serializer de `.fluent-workspace`;
- importacao basica de `.code-workspace`;
- comandos em Arquivo para abrir, salvar, salvar como e adicionar pasta ao
  workspace;
- salvamento local do arquivo de workspace;
- abertura de workspace salvo usando a primeira pasta local como `activeRoot`;
- armazenamento de roots locais e SSH no arquivo, sem senha/passphrase;
- associacao de bundle para `.fluent-workspace`;
- suporte a inicializacao por arquivo recebido em `argv` (duplo clique no
  Windows/atalho do sistema operacional).
- Explorer renderiza multiplas roots locais do workspace como nos de topo e
  preserva operacoes basicas dentro da root local correta.
- GitPanel agrupa roots locais do workspace em secoes independentes, com status,
  stage/unstage/commit/fetch/pull/push/stash por pasta local.
- Arquivo > Adicionar Pasta SSH ao Workspace usa o fluxo SSH existente, deixa o
  usuario escolher a pasta remota e grava a root SSH no workspace sem salvar
  senha/passphrase.
- Ao abrir um workspace com roots SSH, o app tenta conectar cada root com
  `keyPath` ou agente SSH e o Explorer lista diretorios remotos por `connId`
  explicito quando a conexao esta ativa.
- Workspaces salvos cuja primeira root e SSH abrem sem depender de uma pasta
  local ativa: o App limpa a root local/remote ambiente e deixa o auto-connect
  das roots SSH restaurar o Explorer.
- Arquivos abertos a partir de root SSH conectada carregam/salvam por `connId`
  explicito; previews de imagem/video/audio tambem leem base64 por essa conexao.
- Operacoes basicas do Explorer em root SSH conectada usam `connId` explicito:
  criar arquivo/pasta, renomear, excluir, copiar e mover dentro da mesma root.
- GitPanel tambem usa `connId` explicito para roots SSH conectadas: status,
  stage/unstage, commit, fetch/pull/push, stash e historico/revisoes por root.
- As anotacoes Git dentro do editor (CodeLens de autoria, blame inline/gutter e
  dirty diff) usam a root dona do arquivo aberto e `connId` explicito quando o
  arquivo pertence a uma root SSH do workspace.
- Janelas destacadas preservam a origem da aba remota do workspace: previews de
  imagem/video/audio usam o `connId` da root SSH e o editor textual recebe a
  root correta para recursos de Git/package intelligence.
- SearchPanel pesquisa em todas as roots do workspace, agrupando resultados por
  pasta quando ha multiplas roots, e usa `connId` explicito para roots SSH
  conectadas.
- "Abrir no Terminal Integrado" no Explorer abre terminal local ou SSH conforme
  a root dona do caminho, passando `connId` explicito para roots SSH conectadas.
- Explorer tem menu especifico para roots do workspace: renomear o nome exibido
  e remover a pasta do workspace sem apagar arquivos. Workspaces somente SSH
  tambem continuam renderizando roots no Explorer.
- Menu Arquivo inclui Novo Workspace e Fechar Workspace; fechar/abrir/criar
  workspace passa por guarda de alteracoes nao salvas do arquivo de workspace.
  Adicionar Pasta ao Workspace tambem funciona em workspace vazio.
- StatusBar e BranchPicker resolvem a root Git ativa a partir do arquivo focado
  e usam `connId` explicito quando essa root e SSH conectada; sync/fetch/pull/
  push/publish da barra tambem seguem essa root ativa.
- Historico/diff Git abertos fora do GitPanel (Explorer, blame/status bar e
  revisoes) resolvem a root dona do arquivo e carregam a secao correta do
  GitPanel, usando `connId` explicito para roots SSH conectadas.
- Quick Open (`Ctrl+P`) lista arquivos de todas as roots pesquisaveis do
  workspace, prefixando o caminho relativo com o nome da root em workspaces
  multi-root e usando `connId` explicito para roots SSH conectadas.
- Backlinks resolvem a root de contexto pelo arquivo ativo e usam `connId`
  explicito para indexar roots SSH conectadas.
- GraphView tambem recebe a root de contexto do arquivo ativo e usa `connId`
  explicito para roots SSH conectadas; o cache do grafo separa local/SSH.
- Pacote de contexto copiado para agentes (`buildContextBundle`) usa a root de
  contexto do arquivo ativo e `connId` explicito em roots SSH. As posicoes
  persistidas do grafo tambem separam local/SSH.
- Acao de "Revelar no Explorer" em roots SSH agora se apresenta como "Copiar
  Caminho Remoto" e copia o path remoto, evitando tentar abrir uma pasta SSH no
  Explorer local.
- Em workspaces sem `rootPath` local, o Explorer seleciona automaticamente a
  primeira root disponivel e a toolbar de criar/atualizar passa a operar tambem
  em roots SSH conectadas.
- "Localizar na pasta" vindo do Explorer carrega o `rootId` da root dona do
  caminho, evitando ambiguidade entre roots remotas com paths iguais em hosts
  diferentes.
- Explorer/abas passam a combinar `git status` de todas as roots do workspace
  pesquisaveis, incluindo roots SSH conectadas, para badges/decoracoes e para a
  visualizacao "mostrar apenas arquivos alterados".
- Acoes Git do menu avancado do Explorer ("Abrir Alteracoes" e "Historico do
  Arquivo") agora sao habilitadas por root dona do arquivo, nao mais pelo repo
  Git ativo global.
- Quick Open preserva a origem SSH do resultado (`folderId`/`connId`) ao abrir
  arquivos de roots remotas, evitando depender apenas do path quando roots
  remotas diferentes compartilham a mesma estrutura de diretorios.
- Resultados da busca tambem preservam a origem SSH (`folderId`/`connId`) ao
  abrir arquivos, inclusive em busca escopada por subpasta de uma root remota.
- Backlinks/Grafo preservam a origem SSH da root de contexto ao abrir arquivos
  relacionados, mantendo os cliques dentro da mesma root remota analisada.
- O GraphView principal tambem preserva a origem SSH ao abrir nos do grafo por
  duplo clique/canvas/lista acessivel.
- Explorer multi-root ganhou identidade visual de workspace: cabecalho proprio,
  badges LOCAL/SSH nas roots e menu de area vazia com acoes para adicionar pasta
  local ou SSH ao workspace, alem dos mesmos atalhos no toolbar.
- O Explorer agora recebe uma flag explicita de workspace do App, entao
  workspaces salvos/criados continuam com visual de workspace mesmo com uma
  unica root; pastas comuns abertas continuam com visual de projeto simples.
- Workspaces vazios tambem mantem a superficie do Explorer ativa, com estado
  vazio proprio e menu de contexto/toolbar para adicionar roots locais ou SSH.
- Roots do Explorer em workspace mostram metadado visual de origem: caminho
  local ou `usuario@host:/path` para SSH, incluindo estado conectado/
  conectando/erro tambem nas roots remotas indisponiveis.
- Agentes agora carregam/salvam historico, aquecem o provedor, criam snapshot e
  montam referencia do editor usando a root local ativa do workspace, em vez de
  assumir sempre a primeira `rootPath` da janela.
- TitleBar, WelcomeScreen e StatusBar exibem a identidade do workspace e a root
  ativa, deixando claro quando a janela esta em modo multi-root e quando o foco
  atual esta em uma root SSH.
- O painel Executar e Depurar agora agrupa configuracoes e sugestoes por root
  do workspace; roots SSH conectadas carregam/salvam/detectam configs via
  `connId` explicito e executam no terminal SSH da root correta.
- PackagesPanel agora agrupa a analise de pacotes por root do workspace,
  incluindo scan de manifests em roots SSH conectadas via `connId` explicito;
  checagem de versoes, audit e consulta de versoes publicadas por SSH executam
  a CLI do gerenciador na root remota e reutilizam os mesmos parsers locais.
- Hovers/acoes inline de package.json tambem carregam scan/outdated/audit/
  versions usando `connId` quando o arquivo aberto pertence a uma root SSH do
  workspace.
- O Explorer agora carrega a identidade da root em cada no (`workspaceRootId`) e
  propaga a origem SSH (`folderId`/`connId`) para os filhos listados por SFTP,
  evitando resolver roots remotas apenas por path quando ha multiplas pastas.
- Roots SSH desconectadas/conectando/erro aparecem no mesmo nivel das demais
  roots do workspace, com visual compacto estilo VS Code e acoes inline para
  conectar, desconectar e remover a pasta do workspace.
- Acoes individuais do Explorer em modo workspace foram movidas para cada root:
  novo arquivo, nova pasta, atualizar, recolher, conectar/desconectar SSH e
  remover. O toolbar global fica reservado para acoes do workspace/filtros.
- Roots do workspace ganharam divisores discretos entre projetos, mantendo uma
  leitura mais proxima de uma lista multi-root do VS Code.
- A sessao do app agora persiste o shell do workspace ativo, inclusive quando o
  usuario ainda nao salvou um `.fluent-workspace`; ao reabrir a janela, as roots
  locais/SSH voltam como estavam, sem salvar segredos.
- A reconexao manual de root SSH no Explorer abre o dialogo de credenciais
  pre-preenchido da propria root. Isso cobre roots adicionadas com senha ou
  passphrase, que nao podem ser reconectadas apenas por agente/chave salva.
- A listagem multi-root foi refinada: o Explorer nao mostra mais contador de
  pastas no subtitulo, roots locais usam apenas um indicador discreto, e roots
  de workspace nao ficam com highlight persistente apos clique.
- Ao transformar uma pasta simples em workspace multi-root, o nome padrao passa
  a ser `Workspace` em vez de herdar o nome da primeira pasta. Workspaces salvos
  preservam o nome escolhido.
- Ao adicionar uma pasta SSH ao workspace, a conexao recem-criada e reaproveitada
  imediatamente para a root, entao os arquivos remotos aparecem sem exigir uma
  segunda acao de conectar.
- Ao restaurar uma sessao/workspace com roots SSH, roots com `keyPath` tentam
  reconectar automaticamente; roots sem chave segura abrem uma unica vez o
  dialogo de credenciais pre-preenchido e podem ser canceladas sem loop.

Ainda pendente para concluir a feature:

- Explorer multi-root completo, incluindo refinamentos de root ativa por foco e
  comandos globais que ainda assumem uma unica root;
- superficie extensivel de Timeline por root/arquivo, começando por historico de
  alteracoes do arquivo ativo e abrindo espaco para extensoes de dependencias;
- Git completo por workspace: alguns comandos globais ainda precisam resolver a
  root correta em todos os fluxos;
- roteamento de filesystem por `folderId` em vez de `getActiveRemote()` global;
- operacoes avancadas por root SSH conectada: grafo agregado entre multiplas
  roots e LSP por `folderId`;
- abertura de arquivos por evento nativo em app ja rodando quando a versao do
  Tauri usada pelo projeto expuser esse evento no desktop.

## Objetivo

Adicionar ao Fluent Coder um recurso de workspace multi-root: uma janela pode
conter varias pastas de projeto, cada uma com sua propria origem. A origem pode
ser local ou SSH. O primeiro alvo e SSH; o formato deve permitir outros
provedores no futuro sem reescrever Explorer, Git, LSP, busca, grafo e agentes.

## Referencias

- VS Code multi-root workspaces: https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces
- VS Code workspace file: https://code.visualstudio.com/docs/editing/workspaces/workspaces
- VS Code settings em multi-root: https://code.visualstudio.com/docs/configure/settings
- Pedido recorrente de hosts remotos por workspace no ecossistema VS Code:
  https://github.com/microsoft/vscode-remote-release/issues/9746

## Diferenca de produto

O VS Code trata a janela remota como uma autoridade unica: a janela esta local
ou anexada a um host remoto. O Fluent Workspace deve permitir uma janela com:

- uma pasta local `C:\src\web`;
- uma pasta local `C:\src\api`;
- uma pasta remota SSH `ssh://deploy@prod/srv/app`;
- cada pasta com Git, busca, terminal, grafo e contexto isolados por raiz.

Isso resolve o caso em que o usuario precisa trabalhar em projetos relacionados
que vivem em maquinas diferentes sem abrir varias janelas.

## Formato do arquivo

Extensao recomendada: `.fluent-workspace`.

Motivos:

- identifica claramente que o arquivo abre o Fluent Coder;
- permite associacao nativa no Tauri/Windows/macOS/Linux;
- preserva espaco para campos remotos que `.code-workspace` nao cobre bem;
- ainda permite importar `.code-workspace` local no futuro.

Exemplo:

```json
{
  "fluentWorkspace": 1,
  "name": "BlackRed",
  "folders": [
    {
      "name": "FluentCoder",
      "path": "C:/Users/rafae/Documents/Projetos/BlackRed/FluentCoder"
    },
    {
      "name": "site-prod",
      "path": "/var/www/site",
      "remote": {
        "type": "ssh",
        "host": "prod",
        "user": "deploy",
        "port": 22
      }
    }
  ],
  "git": {
    "mode": "perFolder"
  },
  "settings": {}
}
```

Regras do formato:

- `fluentWorkspace` e obrigatorio e comeca em `1`.
- `folders` e obrigatorio e deve ser uma lista.
- pasta sem `remote` e local.
- `remote.type` comeca apenas com `"ssh"`.
- senha/passphrase nunca entram no arquivo.
- `id` pode ser omitido; o app gera um id estavel por origem + caminho.
- `git.mode` padrao: `"perFolder"`.

## Modelo interno

O app precisa parar de tratar `rootPath` como "o workspace inteiro" e passar a
ter dois conceitos:

- `workspace`: conjunto de raizes abertas, metadata e arquivo salvo.
- `activeRoot`: raiz usada por comandos que ainda sao single-root.

Tipos conceituais:

```ts
type WorkspaceFolder =
  | { id: string; kind: "local"; name: string; path: string }
  | {
      id: string;
      kind: "ssh";
      name: string;
      path: string;
      ssh: { host: string; user: string; port: number; keyPath?: string };
    };

type WorkspaceState = {
  id: string;
  name: string;
  filePath: string | null;
  folders: WorkspaceFolder[];
  activeFolderId: string | null;
  dirty: boolean;
};
```

## Git multi-workspace

O Git deve ser por pasta, nao global:

- cada `WorkspaceFolder` tem seu proprio `GitStatus`;
- o painel Git mostra secoes por pasta;
- a StatusBar mostra a branch da pasta ativa, com agregados de problemas;
- stage/commit/pull/push operam na secao selecionada;
- comando "Sincronizar tudo" pode iterar em todas as raizes com repo.

Primeira fase: manter o `GitPanel` atual apontando para `activeRoot`. Segunda
fase: transformar em `MultiGitPanel` com grupos por `folderId`.

## Explorer multi-root

O Explorer deve renderizar cada root como um no de topo:

```text
BLACKRED
  FluentCoder        local
  site-prod          ssh prod:/var/www/site
```

Cada chamada de filesystem deve receber `folderId` ou resolver a partir do path
absoluto. O modelo atual com `getActiveRemote()` e ambient SSH funciona para
single-root, mas precisa virar roteamento por raiz:

- local: `read_dir(path)`;
- SSH: `ssh_list_dir(connId, path)`;
- futuro: provider `container`, `wsl`, etc.

## LSP, busca e contexto

Curto prazo:

- LSP roda apenas para a pasta ativa.
- busca global itera pelas raizes e agrupa resultados por pasta.
- grafo/backlinks recebem um seletor de pasta ou constroem um grafo agregado
  com `folderId` nos nos.

Medio prazo:

- `useLspManager` gerencia servidores por `folderId`;
- diagnosticos guardam `folderId`;
- Quick Open, agentes e contexto usam caminhos exibidos como
  `NomeDaPasta/caminho/relativo`.

## SSH

O workspace salva somente dados nao secretos:

- host;
- port;
- user;
- keyPath opcional;
- remote path.

Ao abrir um workspace com raiz SSH:

1. tentar conectar usando `keyPath` ou agente SSH;
2. pedir senha/passphrase somente quando necessario;
3. manter uma conexao viva por pasta remota;
4. fechar conexoes ao remover a pasta ou fechar o workspace.

## Menus esperados

Arquivo:

- Novo Workspace
- Abrir Workspace...
- Salvar Workspace
- Salvar Workspace Como...
- Adicionar Pasta ao Workspace...
- Adicionar Pasta SSH ao Workspace...
- Remover Pasta do Workspace
- Fechar Workspace

Explorer:

- botao ou menu contextual "Adicionar pasta";
- menu contextual em root: renomear exibicao, remover, abrir terminal aqui.

## Associacao do arquivo

No Tauri, a entrega final deve declarar associacao para `.fluent-workspace`.
Ao abrir o arquivo pelo sistema operacional, o app deve receber o path e chamar
o fluxo "Abrir Workspace" em vez de abrir o JSON como texto.

## Fases

### Fase 1: contrato e arquivo

- Criar parser/serializer de `.fluent-workspace`.
- Criar comandos de menu sem alterar o fluxo single-root.
- Salvar workspace local com uma ou mais pastas locais.
- Abrir workspace salvo e escolher a primeira pasta como `activeRoot`.

### Fase 2: Explorer multi-root local

- Renderizar raizes de topo no Explorer.
- Resolver abertura de arquivos por `folderId`.
- Quick Open e busca agrupados por root.
- GitPanel opera sobre root ativa.

### Fase 3: SSH multi-root

- Trocar ambient `getActiveRemote()` por roteador `workspaceFs`.
- Conectar multiplas raizes SSH simultaneamente.
- Manter terminal remoto por root.
- Persistir apenas metadata nao secreta no arquivo.

### Fase 4: Git e LSP multi-root reais

- GitPanel agrupado por root.
- StatusBar com root ativa + resumo agregado.
- `useLspManager` por root.
- diagnostics, grafo, backlinks e agentes conscientes de `folderId`.

## Criterios de aceite da feature completa

- Abrir uma pasta local continua funcionando como hoje.
- Criar workspace com duas pastas locais e salvar em `.fluent-workspace`.
- Fechar e reabrir esse arquivo restaura as duas raizes.
- Adicionar uma pasta SSH ao workspace sem substituir a pasta local.
- Explorer diferencia local/remoto no topo.
- Git mostra status por pasta e acoes atuam na pasta certa.
- Arquivos de pastas diferentes podem ficar abertos lado a lado.
- O arquivo `.fluent-workspace` nao contem segredos.
- Abrir `.fluent-workspace` pelo sistema operacional abre o workspace no app.
