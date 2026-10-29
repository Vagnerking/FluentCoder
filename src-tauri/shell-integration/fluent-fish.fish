# Fluent Coder — shell integration (fish). Gerado pelo app; NÃO edite.
# Carregado com `fish --init-command 'source <este arquivo>'` (depois do
# config.fish do usuário, que não é alterado). Emite as sequências OSC 633.
status is-interactive; or exit
set -q __FLUENT_SI_LOADED; and exit
set -q VSCODE_SHELL_INTEGRATION; and exit
set -g __FLUENT_SI_LOADED 1

function __fluent_esc
    string replace -a '\\' '\\\\' -- $argv[1] | string replace -a ';' '\\x3b' | string replace -a \n '\\x0a' | string replace -a \e '\\x1b' | string replace -a \a '\\x07' | string join '\\x0a'
end

function __fluent_preexec --on-event fish_preexec
    set -g __fluent_running 1
    printf '\e]633;E;%s;%s\a' (__fluent_esc "$argv") "$FLUENT_SI_NONCE"
    printf '\e]633;C\a'
end

function __fluent_postexec --on-event fish_postexec
    set -l st $status
    printf '\e]633;D;%s\a' $st
    set -g __fluent_running 0
end

function __fluent_prompt --on-event fish_prompt
    printf '\e]633;P;Cwd=%s\a' (__fluent_esc "$PWD")
    printf '\e]633;A\a'
end
