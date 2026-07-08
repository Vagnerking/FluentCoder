import { Codicon } from "../../icons/codicons/Codicon";

interface GitFluentFilterInputProps {
  value: string;
  placeholder: string;
  label: string;
  onChange: (value: string) => void;
}

export function GitFluentFilterInput({
  value,
  placeholder,
  label,
  onChange,
}: GitFluentFilterInputProps) {
  const hasValue = value.trim().length > 0;

  return (
    <div className="git-fluent-filter" role="search">
      <Codicon name="search" size={12} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {hasValue ? (
        <button type="button" aria-label="Limpar filtro" onClick={() => onChange("")}>
          <Codicon name="close" size={12} />
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </div>
  );
}
