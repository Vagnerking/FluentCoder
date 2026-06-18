interface ActivityBarProps {
  activeView: string;
  onViewChange: (view: string) => void;
}

function ExplorerIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="4" y="6" width="13" height="15" rx="1" />
      <rect x="7" y="3" width="13" height="15" rx="1" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="15.5" y1="15.5" x2="21" y2="21" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <line x1="6" y1="8.5" x2="6" y2="15.5" />
      <path d="M6 8.5 C6 12 18 12 18 8.5" />
    </svg>
  );
}

function DebugIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <polygon points="7,4 20,12 7,20" />
      <circle cx="12" cy="20" r="2.5" />
    </svg>
  );
}

function ExtensionsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="12" y="12" width="7" height="7" rx="1" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20 C4 16 8 13 12 13 C16 13 20 16 20 20" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2 L12 5 M12 19 L12 22 M2 12 L5 12 M19 12 L22 12 M4.22 4.22 L6.34 6.34 M17.66 17.66 L19.78 19.78 M19.78 4.22 L17.66 6.34 M6.34 17.66 L4.22 19.78" />
    </svg>
  );
}

const VIEWS = [
  { id: 'explorer', label: 'Explorador', icon: <ExplorerIcon /> },
  { id: 'search', label: 'Pesquisar', icon: <SearchIcon /> },
  { id: 'git', label: 'Controle do Código-Fonte', icon: <GitIcon /> },
  { id: 'debug', label: 'Executar e Depurar', icon: <DebugIcon /> },
  { id: 'extensions', label: 'Extensões', icon: <ExtensionsIcon /> },
];

const BOTTOM_VIEWS = [
  { id: 'account', label: 'Contas', icon: <AccountIcon /> },
  { id: 'settings', label: 'Gerenciar', icon: <SettingsIcon /> },
];

export function ActivityBar({ activeView, onViewChange }: ActivityBarProps) {
  return (
    <div className="activity-bar">
      <div className="activity-items">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={`activity-item${activeView === v.id ? ' active' : ''}`}
            aria-label={v.label}
            title={v.label}
            onClick={() => onViewChange(v.id)}
          >
            {v.icon}
          </button>
        ))}
      </div>
      <div className="activity-items-bottom">
        {BOTTOM_VIEWS.map((v) => (
          <button
            key={v.id}
            className={`activity-item${activeView === v.id ? ' active' : ''}`}
            aria-label={v.label}
            title={v.label}
            onClick={() => onViewChange(v.id)}
          >
            {v.icon}
          </button>
        ))}
      </div>
    </div>
  );
}
