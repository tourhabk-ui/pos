'use client';

/**
 * «Когда какая рыба клюёт?» — сезонная сетка видов рыб на карточке тура.
 *
 * Владелец 06.08: «у них крутая рыбалка и рыбы много разной — нужно сделать
 * карточки интереснее и по сезонам». Виды и месяцы клёва — из единого
 * справочника lib/fish-species.ts (тот же, что кормит /fish и ссылки в
 * описаниях); своего списка видов у компонента нет и быть не может.
 *
 * Fail-soft: нет упомянутых видов — компонент не рендерится вовсе.
 */

import Link from 'next/link';
import { MONTH_SHORT, type FishSpecies } from '@/lib/fish-species';

interface Props {
  species: FishSpecies[];
}

export default function FishSeasonCalendar({ species }: Props) {
  if (species.length === 0) return null;

  const now = new Date().getMonth() + 1;
  const rows = [...species].sort(
    (a, b) => a.seasonMonths[0] - b.seasonMonths[0] || a.name.localeCompare(b.name, 'ru'),
  );
  const inSeason = rows.filter(sp => sp.seasonMonths.includes(now));

  return (
    <div>
      {/* Сводка текстом, не только заливкой ячеек: предложение читают
          AI-поиск (GEO) и скринридеры. Имена видов — ссылки на их страницы,
          тем же стилем, что в описании тура (владелец 07.08: «почему нет
          ссылок по видам рыб»). */}
      <p className="text-[15px] text-[var(--text-secondary)] leading-relaxed mb-3">
        {rows.map((sp, i) => (
          <span key={sp.id}>
            <Link
              href={`/fish/${sp.id}`}
              className="font-medium underline decoration-dotted underline-offset-2 transition-colors hover:no-underline"
              style={{ color: sp.color, textDecorationColor: `${sp.color}70` }}
            >
              {sp.name}
            </Link>
            {` — ${sp.season.toLowerCase()}`}
            {i < rows.length - 1 ? '; ' : '.'}
          </span>
        ))}
      </p>

      {inSeason.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 mb-4 text-sm text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--text-primary)]">Сейчас в сезоне:</span>
          {inSeason.map(sp => (
            <Link
              key={sp.id}
              href={`/fish/${sp.id}`}
              className="text-xs font-semibold px-2.5 py-1 rounded-full transition-opacity hover:opacity-80"
              style={{
                background: `color-mix(in srgb, ${sp.color} 14%, transparent)`,
                color: sp.color,
              }}
            >
              {sp.name}
            </Link>
          ))}
        </p>
      )}

      <div className="ds-card p-4 overflow-x-auto">
        <div className="min-w-[560px]">
          {/* Шапка месяцев */}
          <div className="grid items-center" style={{ gridTemplateColumns: '8.5rem repeat(12, 1fr)' }}>
            <span />
            {MONTH_SHORT.map((m, i) => (
              <span
                key={m}
                className={`text-center text-[10px] uppercase tracking-wide pb-2 ${
                  i + 1 === now ? 'font-bold text-[var(--accent)]' : 'text-[var(--text-muted)]'
                }`}
              >
                {m}
              </span>
            ))}
          </div>

          {rows.map(sp => (
            <div
              key={sp.id}
              className="grid items-center border-t border-[var(--border)]"
              style={{ gridTemplateColumns: '8.5rem repeat(12, 1fr)', minHeight: 40 }}
            >
              <Link
                href={`/fish/${sp.id}`}
                className="flex items-center gap-2 pr-2 text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: sp.color }} />
                <span className="truncate">{sp.name}</span>
              </Link>
              {Array.from({ length: 12 }, (_, i) => {
                const m = i + 1;
                const filled = sp.seasonMonths.includes(m);
                const startOfRun = filled && !sp.seasonMonths.includes(m - 1);
                const endOfRun = filled && !sp.seasonMonths.includes(m + 1);
                return (
                  <span key={m} className="h-full flex items-center px-[1px]">
                    <span
                      className="w-full"
                      style={{
                        height: 12,
                        background: filled
                          ? `color-mix(in srgb, ${sp.color} ${m === now ? 85 : 45}%, transparent)`
                          : 'transparent',
                        borderRadius: `${startOfRun ? 6 : 0}px ${endOfRun ? 6 : 0}px ${endOfRun ? 6 : 0}px ${startOfRun ? 6 : 0}px`,
                      }}
                    />
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
