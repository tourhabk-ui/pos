/**
 * components/safety/MarineMammalRules.tsx
 *
 * Правила наблюдения за морскими млекопитающими — в «Что делать при ЧП»
 * (/safety/offline) сразу после встречи с медведем: правила поведения со
 * зверями в одном месте (владелец 20.10).
 *
 * Оформлен как карточки соседних разделов. Серверный блок без состояния. Числа и запреты — только из
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
  const color = 'var(--ocean)';
  return (
    <section
      id="marine"
      className="rounded-xl border overflow-hidden"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      aria-labelledby="marine-rules-title"
    >
      <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="p-2 rounded-lg flex-shrink-0" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
          <Waves className="w-4 h-4" style={{ color }} />
        </div>
        <h2 id="marine-rules-title" className="font-semibold text-[var(--text-primary)]">
          Лежбища и морские млекопитающие: дистанция и тишина
        </h2>
      </div>

      <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border)', background: `color-mix(in srgb, ${color} 6%, transparent)` }}>
        <p className="text-sm font-medium" style={{ color }}>
          Сивучи, тюлени, моржи и каланы уязвимы к беспокойству. Тревога зверей —
          нарушение правил, за него предусмотрена административная ответственность.
        </p>
      </div>

      <div className="px-5 py-4 space-y-2 border-b" style={{ borderColor: 'var(--border)' }}>
        {MARINE_DISTANCES.map(d => (
          <div key={d.situation} className="flex justify-between items-baseline gap-3 text-sm">
            <span className="text-[var(--text-secondary)]">{d.situation}</span>
            <span className="font-bold whitespace-nowrap" style={{ color }}>
              не ближе {distanceLabel(d)}
            </span>
          </div>
        ))}
      </div>

      <div className="px-5 py-4 text-sm">
        <p className="font-semibold text-[var(--text-primary)] mb-1">Нельзя</p>
        <ul className="list-disc pl-5 space-y-1 mb-3 text-[var(--text-secondary)] leading-relaxed">
          {MARINE_PROHIBITIONS.map(p => (
            <li key={p}>{p}</li>
          ))}
        </ul>

        <p className="font-semibold text-[var(--text-primary)] mb-1">С лодки</p>
        <p className="text-[var(--text-secondary)] leading-relaxed">
          До {MARINE_BOAT.motorStopAtMetres} м — малым ходом ({MARINE_BOAT.motorSlowKmh[0]}–{MARINE_BOAT.motorSlowKmh[1]} км/ч),
          затем заглушить мотор и выждать {MARINE_BOAT.pauseMinutes[0]}–{MARINE_BOAT.pauseMinutes[1]} минут; дальше на вёслах
          или {MARINE_BOAT.finalKmh[0]}–{MARINE_BOAT.finalKmh[1]} км/ч, не ближе {MARINE_BOAT.nearestMetres} м. Если звери
          тревожатся и готовятся сойти в воду — сразу отойти на {MARINE_BOAT.retreatMetres} м. Между судами не меньше{' '}
          {MARINE_BOAT.minBetweenBoatsMetres} м, у малой залежки — не больше {MARINE_BOAT.maxBoatsAtSmallHaulout} судов.
        </p>
      </div>

      <p className="px-5 pb-4 text-xs text-[var(--text-muted)]">Источник: {MARINE_RULES_SOURCE}.</p>
    </section>
  );
}
