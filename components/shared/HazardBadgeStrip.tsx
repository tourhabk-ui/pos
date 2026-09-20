'use client';

import { AlertTriangle, Wind, Mountain, Thermometer, Flame, Waves, Eye, CloudLightning, Signal, Users } from 'lucide-react';
import { MCHS_ONLINE_FORM_URL, MCHS_DEADLINE_SHORT } from '@/lib/safety/mchs-registration';
// Названия опасностей — один список на платформу (lib/safety/hazard-labels).
// Здесь лежала своя копия, и она уже разошлась с остальными пятью.
import { hazardLabel, hazardPhrase } from '@/lib/safety/hazard-labels';


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

/**
 * Те же опасности ПРЕДЛОЖЕНИЯМИ, а не ярлыками (19.09, направление D).
 *
 * Бейдж «Термальные зоны» человек ещё должен расшифровать сам; строка «Есть
 * термальные зоны — горячая земля и вода» читается сразу. Это та же правка
 * речи, что в срезах 1-2 карточки места.
 *
 * Живёт РЯДОМ с бейджами намеренно: уровень опасности (`HAZARD_SEVERITY`) и
 * иконки — общие для обоих видов, и разносить их по файлам значило бы завести
 * второй набор правил ровно там, где мы только что свели шесть списков в один.
 * Два представления, один источник.
 *
 * Фраза берётся из `hazardPhrase`; нет фразы — остаётся ярлык
 * (`hazardLabel` вернёт хотя бы сырой ключ). Пропасть опасность не может:
 * незнание словаря не должно выглядеть как отсутствие опасности.
 *
 * Регистрация МЧС — не опасность, а требование, и стоит отдельной строкой с
 * той же ссылкой, что у бейджа: копия действия расходится поведением (#887).
 */
export function HazardPhraseList({ hazards, mchsRequired, className = '' }: Props) {
  if (!hazards.length && !mchsRequired) return null;
  return (
    <ul className={`space-y-2.5 ${className}`}>
      {hazards.map(h => {
        const color = SEVERITY_VAR[HAZARD_SEVERITY[h] ?? 'warning'];
        return (
          <li key={h} className="flex items-start gap-2.5">
            <span className="mt-0.5 flex-shrink-0" style={{ color }}>
              <HazardIcon hazard={h} />
            </span>
            <span className="text-[15px] leading-snug text-[var(--text-primary)]">
              {hazardPhrase(h) ?? hazardLabel(h)}
            </span>
          </li>
        );
      })}
      {mchsRequired && (
        <li className="flex items-start gap-2.5">
          <span className="mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }}>
            <Users className="w-3 h-3 flex-shrink-0" />
          </span>
          <span className="text-[15px] leading-snug text-[var(--text-primary)]">
            Отметиться в МЧС обязательно.{' '}
            <a
              href={MCHS_ONLINE_FORM_URL}
              title={MCHS_DEADLINE_SHORT}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-[var(--ocean)] underline underline-offset-2 hover:opacity-80"
            >
              Зарегистрировать группу
            </a>
          </span>
        </li>
      )}
    </ul>
  );
}

export function HazardBadgeStrip({ hazards, mchsRequired, className = '' }: Props) {
  if (!hazards.length && !mchsRequired) return null;
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {hazards.map(h => {
        const sev: Severity = HAZARD_SEVERITY[h] ?? 'warning';
        const color = SEVERITY_VAR[sev];
        const label = hazardLabel(h);
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
          href={MCHS_ONLINE_FORM_URL}
          title={MCHS_DEADLINE_SHORT}
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
