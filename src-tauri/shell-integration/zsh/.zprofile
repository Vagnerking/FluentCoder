# Fluent Coder — shell integration (zsh). Gerado pelo app; NÃO edite.
if [[ -f "$FLUENT_USER_ZDOTDIR/.zprofile" ]]; then
  FLUENT_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$FLUENT_USER_ZDOTDIR"
  . "$FLUENT_USER_ZDOTDIR/.zprofile"
  ZDOTDIR="$FLUENT_ZDOTDIR"
fi
