'use client';

import { AlertTriangle, Wind, Mountain, Thermometer, Flame, Waves, Eye, CloudLightning, Signal, Users } from 'lucide-react';

const HAZARD_LABELS: Record<string, string> = {
  bears: 'Медведи',
  wildlife: 'Дикие животные',
  avalanche: 'Лавины',
  rockfall: 'Камнепад',
  thermal: 'Термальные зоны',
  volcanic_gas: 'Вулканические газы',
  altitude: 'Высота',
  ice: 'Лёд',
  weather: 'Непогода',
  river_crossing: 'Переправа',
  fog: 'Туман',
  no_signal: 'Нет связи',
};

type Severity = 'danger' | 'warning' | 'ocean';

const HAZARD_SEVERITY: Record<string, Severity> = {
  bears: 'danger', wildlife: 'danger', volcanic_gas: 'danger',
  avalanche: 'warning', rockfall: 'warning', thermal: 'warning',
  altitude: 'warning', ice: 'warning', weather: 'warning',
  river_crossing: 'ocean', no_signal: 'ocean', fog: 'ocean',
};

const SEVERITY_VAR: Record<Severity, string> = {
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  ocean: 'var(--ocean)',
};

function HazardIcon({ hazard }: { hazard: string }) {
  const cls = 'w-3 h-3 flex-shrink-0';
  switch (hazard) {
    case 'bears': case 'wildlife': return <AlertTriangle className={cls} />;
    case 'avalanche': return <Wind className={cls} />;
    case 'rockfall': case 'altitude': return <Mountain className={cls} />;
    case 'thermal': return <Thermometer className={cls} />;
    case 'volcanic_gas': return <Flame className={cls} />;
    case 'river_crossing': return <Waves className={cls} />;
    case 'fog': return <Eye className={cls} />;
    case 'ice': case 'weather': return <CloudLightning className={cls} />;
    case 'no_signal': return <Signal className={cls} />;
    default: return <AlertTriangle className={cls} />;
  }
}

interface Props {
  hazards: string[];
  mchsRequired?: boolean;
  className?: string;
}

export function HazardBadgeStrip({ hazards, mchsRequired, className = '' }: Props) {
  if (!hazards.length && !mchsRequired) return null;
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {hazards.map(h => {
        const sev: Severity = HAZARD_SEVERITY[h] ?? 'warning';
        const color = SEVERITY_VAR[sev];
        const label = HAZARD_LABELS[h] ?? h;
        return (
          <span
            key={h}
            className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full"
            style={{
              color,
              background: `color-mix(in srgb, ${color} 14%, var(--bg-card))`,
              border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
            }}
          >
            <HazardIcon hazard={h} />
            {label}
          </span>
        );
      })}
      {mchsRequired && (
        <a
          href="https://forms.mchs.gov.ru/registration_tourist_groups/form"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full hover:opacity-80 transition-opacity"
          style={{
            color: 'var(--warning)',
            background: 'color-mix(in srgb, var(--warning) 14%, var(--bg-card))',
            border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
          }}
        >
          <Users className="w-3 h-3 flex-shrink-0" />
          Регистрация МЧС
        </a>
      )}
    </div>
  );
}
