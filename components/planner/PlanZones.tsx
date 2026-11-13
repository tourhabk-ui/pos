/**
 * Блок «Зоны» над днями плана (#3338) — сколько дней плана в каждой зоне.
 *
 * Прогон 13.11: все пять дней в Авачинской зоне, а блок показывал ещё
 * «Восточная зона 10%». Процент был баллом совпадения зоны с интересами
 * (recommendTrip, `ZoneRecommendation.score`), а читался как доля поездки.
 * Теперь блок считает сами дни плана — по той же зоне, что подписана у дня
 * (`zoneShown`, иначе `zone`), — и зоны без дней не показывает.
 *
 * Загрузка зоны (`crowdScore`) — из рекомендации, как раньше: метка только
 * при измеренной загрузке выше половины, `null` — метки нет.
 */
import { zoneHex, zoneName } from '@/lib/planner/zone-style';

export interface PlanZoneDay {
  zone: string | null;
  /** Зона, показанная человеку у дня; `undefined` — берётся `zone`. */
  zoneShown?: string | null;
}

function daysWord(n: number): string {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return 'дней';
  const m10 = n % 10;
  if (m10 === 1) return 'день';
  if (m10 >= 2 && m10 <= 4) return 'дня';
  return 'дней';
}

/** Зоны в порядке первого появления в плане и число дней в каждой. */
export function planZoneDays(days: readonly PlanZoneDay[]): Array<{ zone: string | null; days: number }> {
  const out = new Map<string, { zone: string | null; days: number }>();
  for (const d of days) {
    const zone = d.zoneShown !== undefined ? d.zoneShown : d.zone;
    const key = zone ?? '';
    const row = out.get(key) ?? { zone, days: 0 };
    row.days++;
    out.set(key, row);
  }
  return [...out.values()];
}

export function PlanZones({ days, crowd }: {
  days: readonly PlanZoneDay[];
  crowd: ReadonlyArray<{ zone: string; crowdScore?: number | null }>;
}) {
  const rows = planZoneDays(days);
  if (rows.length === 0) return null;
  const crowdOf = new Map(crowd.map((z) => [z.zone, z.crowdScore]));
  return (
    <div data-testid="plan-zones">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2">Зоны</p>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((r) => {
          const c = r.zone ? crowdOf.get(r.zone) : undefined;
          return (
            <div key={r.zone ?? ''} className="flex items-center gap-1.5 px-2.5 py-1 bg-[var(--bg-hover)] rounded-full border border-[var(--border)]">
              <div className="w-2 h-2 rounded-full" style={{ background: zoneHex(r.zone) }} />
              <span className="text-xs font-medium text-[var(--text-primary)]">{zoneName(r.zone)}</span>
              <span className="text-[10px] text-[var(--text-muted)]">{r.days} {daysWord(r.days)}</span>
              {typeof c === 'number' && c > 50 && (
                <span className={`text-[10px] font-medium ${c > 70 ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)]'}`}>
                  {c > 70 ? 'загружено' : 'умеренно'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
