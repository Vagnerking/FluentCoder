# Fluent Coder — shell integration (bash). Gerado pelo app; NÃO edite.
# Carregado com `bash --init-file <este arquivo> -i` nos terminais das
# extensões: carrega a configuração do usuário (sem alterá-la) e emite as
# sequências OSC 633 do VS Code (A/B prompt, E linha de comando, C início,
# D;<código> fim, P;Cwd=<pasta>) que o app usa para a shell integration.
if [ -n "${__FLUENT_SI_LOADED:-}" ]; then return 0 2>/dev/null || exit 0; fi
__FLUENT_SI_LOADED=1

# --- configuração do usuário (o que um shell de login interativo carregaria)
if [ "${FLUENT_SHELL_LOGIN:-}" = "1" ]; then
  [ -r /etc/profile ] && . /etc/profile
  if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
  elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
  elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
  fi
else
  [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
fi
unset FLUENT_SHELL_LOGIN

# Shell não interativo ou integração já presente (ex.: VS Code): não duplica.
case "$-" in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac
if [ -n "${VSCODE_SHELL_INTEGRATION:-}" ]; then return 0 2>/dev/null || exit 0; fi

__fluent_esc() {
  # Escapa \ ; e controles como o VS Code (\\, \x3b, \xHH).
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
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
  printf '%s' "$out"
}

__fluent_at_prompt=0
__fluent_running=0

__fluent_preexec() {
  # DEBUG trap: só o 1º comando digitado depois do prompt conta.
  [ "$__fluent_at_prompt" = "1" ] || return
  [ -n "${COMP_LINE:-}" ] && return
  case "$BASH_COMMAND" in __fluent_precmd*) return ;; esac
  __fluent_at_prompt=0
  __fluent_running=1
  local line
  line="$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)"
  if [[ "$line" =~ ^\ *[0-9]+\*?\ +(.*)$ ]]; then line="${BASH_REMATCH[1]}"; else line="$BASH_COMMAND"; fi
  builtin printf '\e]633;E;%s;%s\a' "$(__fluent_esc "$line")" "${FLUENT_SI_NONCE:-}"
  builtin printf '\e]633;C\a'
}

__fluent_precmd() {
  local status=$?
  if [ "$__fluent_running" = "1" ]; then
    builtin printf '\e]633;D;%s\a' "$status"
  fi
  __fluent_running=0
  builtin printf '\e]633;P;Cwd=%s\a' "$(__fluent_esc "$PWD")"
  builtin printf '\e]633;A\a'
  case "$PS1" in *'633;B'*) ;; *) PS1="${PS1}\[\e]633;B\a\]" ;; esac
  __fluent_at_prompt=1
  return $status
}

if [ -n "$(trap -p DEBUG)" ]; then
  # Já existe um DEBUG trap (ex.: bash-preexec): encadeia o nosso antes.
  eval "__fluent_user_debug() { $(trap -p DEBUG | sed -e "s/^trap -- '//" -e "s/' DEBUG\$//") ; }"
  trap '__fluent_preexec; __fluent_user_debug' DEBUG
else
  trap '__fluent_preexec' DEBUG
fi
PROMPT_COMMAND="__fluent_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
