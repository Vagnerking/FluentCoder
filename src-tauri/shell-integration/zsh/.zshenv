# Fluent Coder — shell integration (zsh). Gerado pelo app; NÃO edite.
# Carrega o .zshenv do usuário com o ZDOTDIR dele.
if [[ -f "$FLUENT_USER_ZDOTDIR/.zshenv" ]]; then
  FLUENT_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$FLUENT_USER_ZDOTDIR"
  . "$FLUENT_USER_ZDOTDIR/.zshenv"
  # O .zshenv do usuário pode mudar o ZDOTDIR: o próximo arquivo dele vem de lá.
  [[ "$ZDOTDIR" != "$FLUENT_USER_ZDOTDIR" ]] && FLUENT_USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$FLUENT_ZDOTDIR"
fi
