/**
 * Settings do core (fonte única do schema). Chaves iguais às do VS Code quando
 * existem — `.vscode/settings.json` e as extensões hospedadas leem as mesmas —
 * e `fluent.*` para o que é próprio do app. Os defaults reproduzem o
 * comportamento que o app tinha antes do sistema de settings (ex.: `tabSize` 2,
 * minimap e sticky scroll desligados), para a migração não mudar nada sozinha.
 *
 * Onde cada setting é aplicada: `docs/context/configuracoes.md`.
 */
import type { SettingCategory, SettingSchema, SettingScope, SettingType } from "./registry.ts";

type Def = Omit<SettingSchema, "source" | "category" | "scope" | "type" | "description"> & {
  type?: SettingType | SettingType[];
  scope?: SettingScope;
  description: string;
};

function group(category: SettingCategory, scope: SettingScope, defs: Def[]): SettingSchema[] {
  return defs.map((d, i) => ({
    ...d,
    type: d.type ?? (typeof d.default === "boolean" ? "boolean" : typeof d.default === "number" ? "number" : Array.isArray(d.default) ? "array" : d.default !== null && typeof d.default === "object" ? "object" : "string"),
    scope: d.scope ?? scope,
    category,
    order: d.order ?? i,
    source: "core",
  }));
}

const LO: SettingScope = "language-overridable";

export const CORE_SETTINGS: SettingSchema[] = [
  // ------------------------------------------------------------------ Editor
  ...group("editor", LO, [
    { key: "editor.tabSize", title: "Tamanho da tabulação", default: 2, type: "integer", minimum: 1, maximum: 16, description: "Número de espaços de uma tabulação. Substituído pela detecção de indentação do arquivo quando ela está ligada, e pelo .editorconfig.", tags: ["indentação"] },
    { key: "editor.insertSpaces", title: "Inserir espaços", default: true, description: "Inserir espaços ao pressionar Tab. Substituído pela detecção de indentação e pelo .editorconfig.", tags: ["indentação"] },
    { key: "editor.detectIndentation", title: "Detectar indentação", default: true, description: "Detectar tamanho da tabulação e uso de espaços a partir do conteúdo do arquivo ao abrir.", tags: ["indentação"] },
    { key: "editor.wordWrap", title: "Quebra de linha", default: "off", enum: ["off", "on", "wordWrapColumn", "bounded"], enumLabels: ["Desligada", "Na largura do editor", "Na coluna definida", "No menor entre a largura e a coluna"], description: "Como as linhas longas são quebradas visualmente." },
    { key: "editor.wordWrapColumn", title: "Coluna da quebra de linha", default: 80, type: "integer", minimum: 1, description: "Coluna usada quando a quebra de linha é \"Na coluna definida\" ou \"No menor…\"." },
    { key: "editor.rulers", title: "Réguas", default: [], items: { type: "number" }, description: "Colunas onde desenhar réguas verticais (ex.: [80, 120]). O max_line_length do .editorconfig adiciona uma régua." },
    { key: "editor.lineNumbers", title: "Números de linha", default: "on", enum: ["on", "off", "relative", "interval"], enumLabels: ["Ligados", "Desligados", "Relativos", "A cada 10 linhas"], description: "Exibição dos números de linha." },
    { key: "editor.minimap.enabled", title: "Minimapa", default: false, description: "Mostrar o minimapa à direita do editor." },
    { key: "editor.stickyScroll.enabled", title: "Rolagem fixa", default: false, description: "Fixar no topo os escopos aninhados (classe, método) durante a rolagem." },
    { key: "editor.renderWhitespace", title: "Mostrar espaços em branco", default: "selection", enum: ["none", "boundary", "selection", "trailing", "all"], enumLabels: ["Nunca", "Nas bordas", "Na seleção", "No fim da linha", "Sempre"], description: "Como os caracteres de espaço em branco são desenhados." },
    { key: "editor.renderLineHighlight", title: "Destaque da linha atual", default: "line", enum: ["none", "gutter", "line", "all"], enumLabels: ["Nenhum", "Só na margem", "Na linha", "Margem e linha"], description: "Como a linha do cursor é destacada." },
    { key: "editor.cursorStyle", title: "Estilo do cursor", default: "line", enum: ["line", "block", "underline", "line-thin", "block-outline", "underline-thin"], enumLabels: ["Linha", "Bloco", "Sublinhado", "Linha fina", "Contorno de bloco", "Sublinhado fino"], description: "Formato do cursor de texto.", scope: "window" },
    { key: "editor.cursorBlinking", title: "Piscar do cursor", default: "blink", enum: ["blink", "smooth", "phase", "expand", "solid"], enumLabels: ["Piscar", "Suave", "Fase", "Expandir", "Sem piscar"], description: "Animação do cursor. \"Sem piscar\" é recomendado para quem prefere menos movimento.", scope: "window", tags: ["acessibilidade"] },
    { key: "editor.cursorSmoothCaretAnimation", title: "Animação suave do cursor", default: "off", enum: ["off", "explicit", "on"], enumLabels: ["Desligada", "Só em movimentos explícitos", "Ligada"], description: "Animar o cursor ao mover.", scope: "window" },
    { key: "editor.smoothScrolling", title: "Rolagem suave", default: false, description: "Animar a rolagem do editor.", scope: "window" },
    { key: "editor.mouseWheelZoom", title: "Zoom com Ctrl + roda", default: true, description: "Mudar o tamanho da fonte do editor com Ctrl + roda do mouse.", scope: "window" },
    { key: "editor.scrollBeyondLastLine", title: "Rolar além da última linha", default: false, description: "Permitir rolar o editor além da última linha." },
    { key: "editor.formatOnSave", title: "Formatar ao salvar", default: false, description: "Formatar o arquivo com o servidor de linguagem ao salvar.", tags: ["formatação"] },
    { key: "editor.formatOnPaste", title: "Formatar ao colar", default: true, description: "Formatar o trecho colado (se o formatador da linguagem suportar faixas).", tags: ["formatação"] },
    { key: "editor.formatOnType", title: "Formatar ao digitar", default: true, description: "Formatar a linha após digitar (ex.: ao fechar chave).", tags: ["formatação"] },
    { key: "editor.autoClosingBrackets", title: "Fechar colchetes automaticamente", default: "languageDefined", enum: ["always", "languageDefined", "beforeWhitespace", "never"], enumLabels: ["Sempre", "Conforme a linguagem", "Antes de espaço", "Nunca"], description: "Inserir o fechamento de parênteses, colchetes e chaves." },
    { key: "editor.bracketPairColorization.enabled", title: "Colorir pares de colchetes", default: true, description: "Colorir pares de colchetes por nível de aninhamento." },
    { key: "editor.guides.bracketPairs", title: "Guias de pares de colchetes", default: false, type: ["boolean", "string"], enum: [true, "active", false], enumLabels: ["Sempre", "Só o par ativo", "Desligadas"], description: "Linhas-guia ligando pares de colchetes." },
    { key: "editor.guides.indentation", title: "Guias de indentação", default: true, description: "Linhas-guia de indentação." },
    { key: "editor.folding", title: "Dobrar código", default: true, description: "Permitir dobrar (recolher) blocos de código." },
    { key: "editor.codeLens", title: "CodeLens", default: true, description: "Mostrar CodeLens (referências, testes) acima das declarações." },
    { key: "editor.inlayHints.enabled", title: "Dicas embutidas", default: "on", enum: ["on", "onUnlessPressed", "offUnlessPressed", "off"], enumLabels: ["Ligadas", "Ligadas (somem com Ctrl+Alt)", "Desligadas (aparecem com Ctrl+Alt)", "Desligadas"], description: "Dicas embutidas de tipos e parâmetros (inlay hints)." },
    { key: "editor.linkedEditing", title: "Edição vinculada", default: false, description: "Renomear a tag HTML/XML de fechamento junto com a de abertura." },
    { key: "editor.acceptSuggestionOnEnter", title: "Aceitar sugestão com Enter", default: "on", enum: ["on", "smart", "off"], enumLabels: ["Sim", "Só quando muda o texto", "Não (só Tab)"], description: "Se Enter aceita a sugestão do IntelliSense." },
    { key: "editor.largeFileOptimizations", title: "Otimizar arquivos grandes", default: true, description: "Desligar recursos pesados em arquivos grandes." },
    { key: "fluent.editor.largeFileThresholdMB", title: "Limite de arquivo grande (MB)", default: 5, minimum: 1, maximum: 512, description: "Acima deste tamanho o arquivo abre em modo de arquivo grande (sem LSP, realce nem minimapa).", scope: "window" },
    { key: "editor.accessibilitySupport", title: "Suporte a leitor de tela", default: "auto", enum: ["auto", "on", "off"], enumLabels: ["Automático", "Otimizado para leitor de tela", "Desligado"], description: "Otimizar o editor para leitores de tela.", scope: "window", tags: ["acessibilidade"] },
    { key: "csharp.inlayHints.enabled", title: "Dicas embutidas do C#", default: false, description: "Mostrar dicas de parâmetros e tipos do Roslyn em arquivos C#.", scope: "window", tags: ["csharp"] },
  ]),

  // ------------------------------------------------------------- Aparência
  ...group("appearance", "window", [
    { key: "workbench.colorTheme", title: "Tema de cores", default: "Fluent Acrylic Dark", description: "Tema de cores do editor e da interface. Temas de extensões aparecem quando instalados." },
    { key: "workbench.iconTheme", title: "Tema de ícones", default: "material-icon-theme", type: ["string", "null"], description: "Tema de ícones de arquivos e pastas." },
    { key: "workbench.colorCustomizations", title: "Cores personalizadas", default: {}, editor: "json", description: "Sobrescreve cores do tema atual (ex.: { \"editor.background\": \"#1e1e1e\" })." },
    { key: "fluent.ui.density", title: "Densidade", default: "comfortable", enum: ["compact", "comfortable", "spacious"], enumLabels: ["Compacta", "Confortável", "Espaçosa"], description: "Altura das linhas das listas, abas e barras." },
    { key: "fluent.window.acrylicFlyouts", title: "Menus em acrílico", default: "auto", enum: ["auto", "on", "off"], enumLabels: ["Automático", "Sempre", "Nunca"], description: "Transparência acrílica em menus e flyouts (Windows/macOS). Exige reabrir a janela." },
    { key: "workbench.sideBar.location", title: "Posição da barra lateral", default: "left", enum: ["left", "right"], enumLabels: ["Esquerda", "Direita"], description: "Lado da barra lateral principal. O Fluent Chat fica no lado oposto." },
    { key: "workbench.activityBar.location", title: "Posição da barra de atividades", default: "side", enum: ["side", "right", "top", "bottom"], enumLabels: ["Lateral", "À direita da barra lateral", "Topo", "Base"], description: "Onde ficam os ícones das views (Explorer, Busca, Git…)." },
    { key: "workbench.panel.defaultLocation", title: "Posição do painel", default: "bottom", enum: ["bottom", "left", "right"], enumLabels: ["Embaixo", "Esquerda", "Direita"], description: "Onde o painel (Terminal, Problemas, Saída) é encaixado." },
    { key: "workbench.statusBar.visible", title: "Barra de status visível", default: true, description: "Mostrar a barra de status." },
    { key: "fluent.ui.scale", title: "Zoom da interface", default: 1, minimum: 0.5, maximum: 3, description: "Escala de toda a interface (1 = 100%). Ctrl+= / Ctrl+- / Ctrl+0 também mudam." },
  ]),

  // ------------------------------------------------------------------ Fonte
  ...group("font", LO, [
    { key: "editor.fontFamily", title: "Família da fonte do editor", default: "", description: "Fontes do editor, separadas por vírgula. Vazio = fonte monoespaçada padrão do sistema." },
    { key: "editor.fontSize", title: "Tamanho da fonte do editor", default: 14, minimum: 6, maximum: 100, description: "Tamanho da fonte do editor em pixels." },
    { key: "editor.lineHeight", title: "Altura da linha", default: 0, minimum: 0, maximum: 150, description: "Altura da linha do editor. 0 = automática; valores até 8 multiplicam o tamanho da fonte." },
    { key: "editor.fontLigatures", title: "Ligaduras", default: false, type: ["boolean", "string"], description: "Ligaduras de fonte (ex.: => vira seta em fontes como Fira Code). Também aceita features CSS ('ss01')." },
    { key: "editor.fontWeight", title: "Peso da fonte", default: "normal", description: "Peso da fonte do editor (normal, bold ou 100–900)." },
    { key: "fluent.ui.fontSize", title: "Tamanho da fonte da interface", default: 13, minimum: 10, maximum: 20, description: "Tamanho base do texto da interface (listas, abas, painéis).", scope: "window" },
    { key: "fluent.ui.fontFamily", title: "Família da fonte da interface", default: "", description: "Fonte da interface. Vazio = fonte do sistema.", scope: "window" },
  ]),

  // ---------------------------------------------------------- Acessibilidade
  ...group("accessibility", "window", [
    { key: "workbench.reduceMotion", title: "Reduzir movimento", default: "auto", enum: ["auto", "on", "off"], enumLabels: ["Seguir o sistema", "Ligado", "Desligado"], description: "Desligar animações e transições da interface e do editor.", tags: ["acessibilidade"] },
    { key: "fluent.accessibility.highContrast", title: "Alto contraste", default: "auto", enum: ["auto", "on", "off"], enumLabels: ["Seguir o sistema", "Ligado", "Desligado"], description: "Bordas e textos com contraste reforçado.", tags: ["acessibilidade"] },
    { key: "fluent.accessibility.focusOutline", title: "Contorno de foco reforçado", default: false, description: "Desenhar um contorno de foco mais grosso em todos os controles.", tags: ["acessibilidade"] },
    { key: "fluent.ui.reduceTransparency", title: "Reduzir transparência", default: false, description: "Superfícies opacas no lugar do acrílico.", tags: ["acessibilidade"] },
  ]),

  // ------------------------------------------------------------------ Abas
  ...group("tabs", "window", [
    { key: "workbench.editor.showTabs", title: "Mostrar abas", default: "multiple", enum: ["multiple", "single", "none"], enumLabels: ["Várias", "Só a ativa", "Nenhuma"], description: "Como as abas dos editores aparecem." },
    { key: "workbench.editor.enablePreview", title: "Abas de visualização", default: true, description: "Clique simples abre em uma aba de visualização (itálico) que é substituída pela próxima." },
    { key: "workbench.editor.wrapTabs", title: "Quebrar abas em várias linhas", default: false, description: "Quebrar as abas em várias linhas em vez de rolar." },
    { key: "workbench.editor.tabActionLocation", title: "Posição do botão fechar", default: "right", enum: ["right", "left"], enumLabels: ["Direita", "Esquerda"], description: "Lado do botão de fechar das abas." },
    { key: "workbench.editor.tabSizing", title: "Largura das abas", default: "fit", enum: ["fit", "shrink", "fixed"], enumLabels: ["Ajustar ao nome", "Encolher", "Fixa"], description: "Como a largura das abas se ajusta." },
    { key: "workbench.editor.highlightModifiedTabs", title: "Destacar abas modificadas", default: false, description: "Linha no topo das abas com alterações não salvas." },
  ]),

  // --------------------------------------------------------------- Arquivos
  ...group("files", "resource", [
    { key: "files.autoSave", title: "Salvamento automático", default: "off", enum: ["off", "afterDelay", "onFocusChange", "onWindowChange"], enumLabels: ["Desligado", "Após um intervalo", "Ao trocar de editor", "Ao sair da janela"], description: "Salvar automaticamente os arquivos modificados." },
    { key: "files.autoSaveDelay", title: "Intervalo do salvamento automático (ms)", default: 1000, minimum: 100, description: "Atraso em milissegundos quando o salvamento é \"Após um intervalo\"." },
    { key: "files.eol", title: "Fim de linha padrão", default: "auto", enum: ["auto", "\n", "\r\n"], enumLabels: ["Do sistema", "LF", "CRLF"], description: "Fim de linha de arquivos novos. Arquivos existentes mantêm o seu.", scope: LO },
    { key: "files.encoding", title: "Codificação padrão", default: "utf8", enum: ["utf8", "utf8bom", "utf16le", "utf16be", "windows1252", "iso88591"], enumLabels: ["UTF-8", "UTF-8 com BOM", "UTF-16 LE", "UTF-16 BE", "Windows 1252", "ISO 8859-1"], description: "Codificação de arquivos novos (a detecção continua valendo para existentes).", scope: LO },
    { key: "files.trimTrailingWhitespace", title: "Remover espaços no fim da linha", default: false, description: "Remover espaços em branco no fim das linhas ao salvar.", scope: LO },
    { key: "files.insertFinalNewline", title: "Inserir nova linha final", default: false, description: "Garantir uma quebra de linha no fim do arquivo ao salvar.", scope: LO },
    { key: "files.trimFinalNewlines", title: "Remover linhas finais extras", default: false, description: "Deixar no máximo uma quebra de linha no fim do arquivo ao salvar.", scope: LO },
    { key: "files.exclude", title: "Excluir arquivos", default: { "**/.git": true, "**/.svn": true, "**/.hg": true, "**/.DS_Store": true, "**/Thumbs.db": true, "**/bin": true, "**/obj": true }, editor: "json", description: "Globs escondidos no Explorer, no Quick Open e na busca ({ \"glob\": true })." },
    { key: "files.watcherExclude", title: "Excluir do observador", default: { "**/.git/objects/**": true, "**/node_modules/*/**": true }, editor: "json", description: "Globs ignorados pelo observador de arquivos das extensões." },
    { key: "files.associations", title: "Associações de arquivos", default: {}, editor: "json", description: "Associa padrões de arquivo a linguagens (ex.: { \"*.tpl\": \"html\" })." },
    { key: "files.maxMemoryForLargeFilesMB", title: "Arquivo enorme (MB)", default: 50, minimum: 1, description: "Acima deste tamanho o app pergunta antes de abrir (e abre somente leitura).", scope: "window" },
    { key: "explorer.confirmDelete", title: "Confirmar exclusão", default: true, description: "Pedir confirmação ao mover arquivos para a lixeira.", scope: "window" },
  ]),

  // ------------------------------------------------------------------ Busca
  ...group("search", "resource", [
    { key: "search.exclude", title: "Excluir da busca", default: { "**/node_modules": true, "**/bower_components": true, "**/*.code-search": true }, editor: "json", description: "Globs ignorados na busca e no Quick Open (somados ao files.exclude)." },
    { key: "search.useIgnoreFiles", title: "Respeitar .gitignore", default: true, description: "Respeitar .gitignore e .ignore na busca." },
    { key: "search.smartCase", title: "Maiúsculas inteligentes", default: false, description: "Diferenciar maiúsculas só quando o termo tiver alguma maiúscula." },
    { key: "fluent.quickOpen.maxFiles", title: "Teto do índice do Quick Open", default: 50000, minimum: 1000, maximum: 1000000, description: "Máximo de arquivos indexados pelo Quick Open (Ctrl+P). Ao bater no teto o Quick Open avisa.", scope: "window" },
  ]),

  // --------------------------------------------------------------- Terminal
  ...group("terminal", "window", [
    { key: "terminal.integrated.defaultProfile.linux", title: "Perfil padrão (Linux)", default: null, type: ["string", "null"], description: "Nome de um perfil em terminal.integrated.profiles.linux. Vazio = $SHELL.", scope: "machine" },
    { key: "terminal.integrated.defaultProfile.osx", title: "Perfil padrão (macOS)", default: null, type: ["string", "null"], description: "Nome de um perfil em terminal.integrated.profiles.osx. Vazio = $SHELL.", scope: "machine" },
    { key: "terminal.integrated.defaultProfile.windows", title: "Perfil padrão (Windows)", default: null, type: ["string", "null"], description: "Nome de um perfil em terminal.integrated.profiles.windows. Vazio = PowerShell.", scope: "machine" },
    { key: "terminal.integrated.profiles.linux", title: "Perfis (Linux)", default: {}, editor: "json", description: "Perfis de terminal: { \"zsh\": { \"path\": \"zsh\", \"args\": [\"-l\"] } }.", scope: "machine" },
    { key: "terminal.integrated.profiles.osx", title: "Perfis (macOS)", default: {}, editor: "json", description: "Perfis de terminal do macOS.", scope: "machine" },
    { key: "terminal.integrated.profiles.windows", title: "Perfis (Windows)", default: {}, editor: "json", description: "Perfis de terminal do Windows (ex.: Git Bash, pwsh).", scope: "machine" },
    { key: "fluent.terminal.shellPath", title: "Shell", default: "", description: "Executável do shell (atalho para um perfil). Vazio = perfil padrão do SO.", scope: "machine" },
    { key: "fluent.terminal.shellArgs", title: "Argumentos do shell", default: [], items: { type: "string" }, description: "Argumentos passados ao shell definido acima.", scope: "machine" },
    { key: "terminal.integrated.fontFamily", title: "Fonte do terminal", default: "", description: "Família da fonte do terminal. Vazio = a do editor." },
    { key: "terminal.integrated.fontSize", title: "Tamanho da fonte do terminal", default: 13, minimum: 6, maximum: 100, description: "Tamanho da fonte do terminal em pixels." },
    { key: "terminal.integrated.lineHeight", title: "Altura da linha do terminal", default: 1.2, minimum: 1, maximum: 3, description: "Multiplicador da altura da linha do terminal." },
    { key: "terminal.integrated.cursorStyle", title: "Estilo do cursor do terminal", default: "block", enum: ["block", "line", "underline"], enumLabels: ["Bloco", "Linha", "Sublinhado"], description: "Formato do cursor do terminal." },
    { key: "terminal.integrated.cursorBlinking", title: "Cursor do terminal piscando", default: true, description: "Piscar o cursor do terminal." },
    { key: "terminal.integrated.scrollback", title: "Histórico (linhas)", default: 1000, minimum: 0, maximum: 1000000, description: "Linhas mantidas no histórico de rolagem do terminal." },
    { key: "terminal.integrated.shellIntegration.enabled", title: "Integração com o shell", default: true, description: "Marcar comandos (OSC 633) para as extensões em bash/zsh/fish." },
  ]),

  // -------------------------------------------------------------------- Git
  ...group("git", "resource", [
    { key: "git.enabled", title: "Git habilitado", default: true, description: "Integração com o Git (status, Controle do Código-Fonte, decorações)." },
    { key: "git.autofetch", title: "Busca automática", default: true, description: "Executar git fetch periodicamente nos repositórios abertos." },
    { key: "git.autofetchPeriod", title: "Intervalo da busca automática (s)", default: 180, minimum: 30, description: "Segundos entre buscas automáticas." },
    { key: "git.confirmSync", title: "Confirmar sincronização", default: true, description: "Pedir confirmação antes de sincronizar (pull + push)." },
    { key: "git.avatars", title: "Avatares", default: "github", enum: ["github", "gravatar", "off"], enumLabels: ["Só GitHub (noreply)", "GitHub e Gravatar", "Desligados (iniciais)"], description: "De onde vêm os avatares dos autores. Gravatar recebe só o hash SHA-256 do e-mail.", scope: "window" },
    { key: "git.repositoryScanMaxDepth", title: "Profundidade da busca de repositórios", default: 1, type: "integer", minimum: 0, maximum: 5, description: "Quantos níveis de subpastas procurar repositórios Git." },
  ]),

  // -------------------------------------------------------------- Extensões
  ...group("extensions", "application", [
    { key: "extensions.autoCheckUpdates", title: "Verificar atualizações", default: true, description: "Verificar atualizações de extensões automaticamente (a cada 12 h)." },
    { key: "extensions.autoUpdate", title: "Atualizar automaticamente", default: false, description: "Instalar atualizações de extensões automaticamente." },
    { key: "extensions.ignoreRecommendations", title: "Ignorar recomendações", default: false, description: "Não mostrar as extensões recomendadas pelo workspace (.vscode/extensions.json).", scope: "window" },
  ]),

  // --------------------------------------------------------- Agentes de IA
  ...group("agents", "window", [
    { key: "fluent.agents.defaultProvider", title: "Agente padrão", default: "", enum: ["", "claude", "codex", "gemini", "opencode", "qwen", "copilot", "goose"], enumLabels: ["Último usado", "Claude Code", "Codex", "Gemini CLI", "opencode", "Qwen Code", "Copilot CLI", "Goose"], description: "Agente selecionado ao abrir um chat novo no Fluent Chat." },
    { key: "fluent.agents.defaultMode", title: "Modo padrão", default: "", enum: ["", "ask", "plan", "edit", "auto"], enumLabels: ["Último usado", "Perguntar", "Planejar", "Editar", "Agente"], description: "Modo de permissão inicial dos chats novos. Bypass nunca é padrão." },
    { key: "fluent.agents.ideBridge.enabled", title: "Ponte IDE do Claude Code", default: true, description: "Permitir que o claude no terminal enxergue o editor (seleção, diagnósticos). Exige reiniciar a ponte.", scope: "application" },
  ]),

  // ----------------------------------------------------------------- Janela
  ...group("window", "window", [
    { key: "window.restoreWindows", title: "Restaurar ao abrir", default: "all", enum: ["all", "none"], enumLabels: ["Última pasta e abas", "Nada"], description: "O que reabrir ao iniciar o app.", scope: "application" },
    { key: "window.confirmBeforeClose", title: "Confirmar ao fechar", default: "keyboardOnly", enum: ["always", "keyboardOnly", "never"], enumLabels: ["Sempre", "Só pelo teclado", "Nunca"], description: "Pedir confirmação ao fechar a janela.", scope: "application" },
    { key: "fluent.settings.workspaceWriteTarget", title: "Onde gravar settings do workspace", default: "fluent", enum: ["fluent", "vscode"], enumLabels: [".fluent/settings.json", ".vscode/settings.json"], description: "Arquivo usado ao alterar uma setting no escopo Workspace/Pasta. Os dois são sempre lidos (.fluent vence)." },
  ]),

  // ------------------------------------------------------------- Linguagens
  ...group("languages", "window", [
    { key: "fluent.typescript.preferEditorVersion", title: "TypeScript: versão do editor", default: false, description: "Usar o TypeScript embutido no app em vez do node_modules do projeto. Reinicia o servidor TS.", tags: ["typescript"] },
    { key: "fluent.razor.projection", title: "Razor: projeção C#", default: false, description: "Servir .cshtml pelo broker de projeção (ADR 0002) em vez do cohosting Razor. Exige resetar os servidores.", tags: ["razor", "csharp"] },
    { key: "fluent.lsp.logToFile", title: "Log dos servidores em arquivo", default: false, description: "Espelhar o log de diagnóstico dos servidores de linguagem em arquivo." },
  ]),
];
