# Fluent Coder — shell integration (zsh). Gerado pelo app; NÃO edite.
# O app inicia o zsh com ZDOTDIR apontando para esta pasta e
# FLUENT_USER_ZDOTDIR com o ZDOTDIR original: cada arquivo daqui carrega o
# do usuário (sem alterá-lo) e este instala os ganchos OSC 633.
if [[ -f "$FLUENT_USER_ZDOTDIR/.zshrc" ]]; then
  FLUENT_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$FLUENT_USER_ZDOTDIR"
  . "$FLUENT_USER_ZDOTDIR/.zshrc"
  ZDOTDIR="$FLUENT_ZDOTDIR"
fi
# Shell que não é de login não lê o .zlogin: devolve o ZDOTDIR do usuário já.
[[ -o login ]] || ZDOTDIR="$FLUENT_USER_ZDOTDIR"

if [[ -o interactive && -z "${__FLUENT_SI_LOADED:-}" && -z "${VSCODE_SHELL_INTEGRATION:-}" ]]; then
  __FLUENT_SI_LOADED=1

  __fluent_esc() {
    local s="$1" out="" c
    local i
    for (( i = 1; i <= ${#s}; i++ )); do
      c="${s[i]}"
      case "$c" in
        '\') out+='\\' ;;
        ';') out+='\x3b' ;;
        $'\n') out+='\x0a' ;;
        $'\r') out+='\x0d' ;;
        $'\t') out+='\x09' ;;
        $'\e') out+='\x1b' ;;
        $'\a') out+='\x07' ;;
        *) out+="$c" ;;
      esac
    done
    print -rn -- "$out"
  }

  __fluent_running=0

  __fluent_preexec() {
    __fluent_running=1
    builtin printf '\e]633;E;%s;%s\a' "$(__fluent_esc "$1")" "${FLUENT_SI_NONCE:-}"
    builtin printf '\e]633;C\a'
  }

  __fluent_precmd() {
    local st=$?
    if [[ "$__fluent_running" = 1 ]]; then
      builtin printf '\e]633;D;%s\a' "$st"
    fi
    __fluent_running=0
    builtin printf '\e]633;P;Cwd=%s\a' "$(__fluent_esc "$PWD")"
    builtin printf '\e]633;A\a'
    [[ "$PS1" == *'633;B'* ]] || PS1="${PS1}%{"$'\e]633;B\a'"%}"
  }

  autoload -Uz add-zsh-hook
  # precmd primeiro (captura o $? antes dos ganchos do usuário).
  precmd_functions=(__fluent_precmd ${precmd_functions[@]})
  add-zsh-hook preexec __fluent_preexec
fi
