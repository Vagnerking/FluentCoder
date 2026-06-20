import { useLayoutEffect, useRef, useState } from 'react';
import { Codicon } from '../icons/codicons/Codicon';
import type { IconAction } from '../icons/codicons/codicon-map';

interface ActivityBarProps {
  activeView: string;
  onViewChange: (view: string) => void;
}

const VIEWS: { id: string; label: string; icon: IconAction }[] = [
  { id: 'explorer', label: 'Explorador', icon: 'explorer' },
  { id: 'search', label: 'Pesquisar', icon: 'search' },
  { id: 'git', label: 'Controle do Código-Fonte', icon: 'sourceControl' },
  { id: 'debug', label: 'Executar e Depurar', icon: 'run' },
  { id: 'agents', label: 'Agentes', icon: 'agents' },
];

const BOTTOM_VIEWS: { id: string; label: string; icon: IconAction }[] = [
  { id: 'account', label: 'Contas', icon: 'account' },
  { id: 'settings', label: 'Gerenciar', icon: 'settings' },
];

export function ActivityBar({ activeView, onViewChange }: ActivityBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const updateIndicator = () => {
      const bar = barRef.current;
      const activeItem = bar?.querySelector<HTMLElement>(
        `.activity-item[data-view="${activeView}"]`,
      );

      if (!bar || !activeItem) {
        setIndicatorTop(null);
        return;
      }

      setIndicatorTop(
        activeItem.offsetTop + (activeItem.offsetHeight - 20) / 2,
      );
    };

    updateIndicator();

    const resizeObserver = new ResizeObserver(updateIndicator);
    if (barRef.current) resizeObserver.observe(barRef.current);

    return () => resizeObserver.disconnect();
  }, [activeView]);

  return (
    <div className="activity-bar" ref={barRef}>
      <span
        className="activity-indicator"
        aria-hidden="true"
        style={{
          opacity: indicatorTop === null ? 0 : 1,
          transform: `translateY(${indicatorTop ?? 0}px)`,
        }}
      />
      <div className="activity-items">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={`activity-item${activeView === v.id ? ' active' : ''}`}
            data-view={v.id}
            aria-label={v.label}
            title={v.label}
            onClick={() => onViewChange(v.id)}
          >
            <Codicon name={v.icon} size={24} />
          </button>
        ))}
      </div>
      <div className="activity-items-bottom">
        {BOTTOM_VIEWS.map((v) => (
          <button
            key={v.id}
            className={`activity-item${activeView === v.id ? ' active' : ''}`}
            data-view={v.id}
            aria-label={v.label}
            title={v.label}
            onClick={() => onViewChange(v.id)}
          >
            <Codicon name={v.icon} size={24} />
          </button>
        ))}
      </div>
    </div>
  );
}
