/**
 * Бэкфилл набора высоты — из своего трека, тем же вычислителем, только в NULL.
 *
 * Три черты, каждая — урок платформы:
 *   - вычислитель один (accumulateRelief): второй счётчик того же числа
 *     разошёлся бы с профилем карточки;
 *   - пишется только reliable: «не смог посчитать» — отсутствие, не ноль;
 *   - только в NULL: паспортное значение не перетирается никогда.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'app/api/cron/elevation-backfill/route.ts'), 'utf-8',
);

describe('бэкфилл набора высоты', () => {
  it('считает вычислителем карточки, а не своим', () => {
    expect(src).toContain("from '@/lib/routes/relief'");
    expect(src).toContain('accumulateRelief(');
  });

  it('ненадёжные высоты не превращаются в число', () => {
    expect(src).toContain('relief.reliable');
  });

  it('пишет только в NULL — паспортные значения неприкосновенны', () => {
    // Окно в 500 знаков после UPDATE: guard стоит в WHERE этого же запроса,
    // а не где-то ещё в файле (в SELECT-выборке он тоже есть — не он судья).
    expect(src).toMatch(/UPDATE kamchatka_routes[\s\S]{0,500}elevation_gain_m IS NULL/);
  });

  it('боевой запуск ограничен партией', () => {
    expect(src).toContain('max(200)');
  });
});
