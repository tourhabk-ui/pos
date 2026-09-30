/**
 * components/safety/MarineMammalRules.tsx
 *
 * Правила наблюдения за морскими млекопитающими на странице безопасности.
 *
 * Серверный блок без состояния. Числа и запреты — только из
 * `lib/safety/marine-mammals` (постановление № 285-П): своих цифр здесь нет,
 * вторая копия расходится с первой (сторож `tests/unit/marine-mammals.test.ts`).
 *
 * Не красный: это подготовка к встрече со зверем, не происшествие; красный
 * на платформе — SOS и тревога.
 */

import { Waves } from 'lucide-react';
import {
  MARINE_DISTANCES,
  MARINE_PROHIBITIONS,
  MARINE_BOAT,
  MARINE_RULES_SOURCE,
  distanceLabel,
} from '@/lib/safety/marine-mammals';

export default function MarineMammalRules() {
  return (
    <section
      className="ds-card"
      style={{ padding: '14px 16px', marginBottom: 12 }}
      aria-labelledby="marine-rules-title"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Waves size={14} color="var(--ocean)" />
        <h2 id="marine-rules-title" style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13, margin: 0 }}>
          Лежбища и морские млекопитающие: дистанция и тишина
        </h2>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
        Сивучи, тюлени, моржи и каланы уязвимы к беспокойству. Тревога зверей —
        нарушение правил, за него предусмотрена административная ответственность.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {MARINE_DISTANCES.map(d => (
          <div key={d.situation} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{d.situation}</span>
            <span style={{ fontWeight: 700, color: 'var(--ocean)', fontSize: 13, whiteSpace: 'nowrap' }}>
              не ближе {distanceLabel(d)}
            </span>
          </div>
        ))}
      </div>

      <p style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, margin: '0 0 4px' }}>Нельзя</p>
      <ul style={{ margin: '0 0 12px', paddingLeft: 18, color: 'var(--text-secondary)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {MARINE_PROHIBITIONS.map(p => (
          <li key={p}>{p}</li>
        ))}
      </ul>

      <p style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, margin: '0 0 4px' }}>С лодки</p>
      <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
        До {MARINE_BOAT.motorStopAtMetres} м — малым ходом ({MARINE_BOAT.motorSlowKmh[0]}–{MARINE_BOAT.motorSlowKmh[1]} км/ч),
        затем заглушить мотор и выждать {MARINE_BOAT.pauseMinutes[0]}–{MARINE_BOAT.pauseMinutes[1]} минут; дальше на вёслах
        или {MARINE_BOAT.finalKmh[0]}–{MARINE_BOAT.finalKmh[1]} км/ч, не ближе {MARINE_BOAT.nearestMetres} м. Если звери
        тревожатся и готовятся сойти в воду — сразу отойти на {MARINE_BOAT.retreatMetres} м. Между судами не меньше{' '}
        {MARINE_BOAT.minBetweenBoatsMetres} м, у малой залежки — не больше {MARINE_BOAT.maxBoatsAtSmallHaulout} судов.
      </p>

      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: 0 }}>Источник: {MARINE_RULES_SOURCE}.</p>
    </section>
  );
}
