/**
 * Сторож: землетрясение накрывает место силой сотрясения, а не зоной (03.10, #2195).
 *
 * Карточка Никольской сопки в Петропавловске: «Сегодня сюда — нет» из-за
 * ML 6.2 в океане за 182 км. Форму SQL судит настоящий PostgreSQL
 * (tests/integration/alert-place-scope.pg.test.ts); здесь — связка и числа.
 */
import { describe, it, expect } from 'vitest';
import { ALERT_MATCH_SQL, QUAKE_SCOPED_SQL } from '@/lib/services/safety/alert-place-scope';
import { shakingIntensity, SEISMIC_PLACE_MIN_INTENSITY } from '@/lib/services/safety/shaking';
import { shakingIntensity as fromAnalyst } from '@/lib/agents/agencies/danger-analyst-agency';

describe('землетрясение и место', () => {
  it('ML 6.2 за 182 км — ниже порога места, ML 6.5 за 20 км — выше', () => {
    expect(shakingIntensity(6.2, 182)).toBeLessThan(SEISMIC_PLACE_MIN_INTENSITY);
    expect(shakingIntensity(6.5, 20)).toBeGreaterThanOrEqual(SEISMIC_PLACE_MIN_INTENSITY);
  });

  it('у толчка с координатой и магнитудой своя ветка, и в зональную он не падает', () => {
    expect(QUAKE_SCOPED_SQL).toMatch(/ea\.alert_type = 'earthquake'/);
    expect(QUAKE_SCOPED_SQL).toMatch(/ea\.magnitude IS NOT NULL/);
    expect(ALERT_MATCH_SQL).toContain(`>= ${SEISMIC_PLACE_MIN_INTENSITY}`);
    expect(ALERT_MATCH_SQL).toMatch(/AND NOT \(\s*ea\.alert_type = 'earthquake'/);
  });

  it('формула одна: риск зоны и привязка к месту считают одинаково', () => {
    expect(fromAnalyst).toBe(shakingIntensity);
  });
});
