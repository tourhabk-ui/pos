/**
 * Карточка маршрута «Гора Замок» — скрины владельца 03.10.
 *
 * Три дефекта одной страницы, каждый со своим механизмом:
 *
 *  1. Кнопки «Начать навигацию» не было: она требовала двух путевых точек,
 *     а у маршрута снятый трек на 6.9 км и одна точка. Полевой экран при
 *     этом ведёт и по одному треку (начало и конец линии) — запирала кнопка,
 *     а не поле.
 *  2. «Проезд по территории парка ограничен… 23.08.2026» стоял в октябре
 *     текущим сигналом: предупреждение без срока жило вечно. Правило «без
 *     срока — UNDATED_ALERT_HORIZON_DAYS суток от публикации» одно на
 *     карточку, планировщик и форму администратора.
 *  3. Отбор тревог маршрута — правилом мест; держит collect-signals.test.ts
 *     и исполняет alert-place-scope.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNDATED_ALERT_HORIZON_DAYS } from '@/lib/safety/alert-horizon';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const CARD = read('app/routes/[id]/_RouteDetailClient.tsx');

describe('кнопка «Начать навигацию» — при любой линии', () => {
  it('не зависит от числа путевых точек', () => {
    const buttons = CARD.split('onClick={handleStartNavigation}').slice(0, -1);
    expect(buttons.length).toBe(2); // основная колонка и боковая
    for (const before of buttons) {
      const cond = before.slice(before.lastIndexOf('{'), before.length);
      expect(cond).toMatch(/\{hasTrack && \(/);
      expect(cond).not.toMatch(/navWaypoints\.length/);
    }
  });

  it('полевой экран умеет вести без путевых точек — иначе кнопка вела бы в пустоту', () => {
    const planning = read('app/planning/_PlanningClient.tsx');
    expect(planning).toContain("name: 'Начало трека'");
    expect(planning).toContain("name: 'Конец трека'");
  });
});

describe('предупреждение без срока — снимок дня публикации', () => {
  it('число одно, и разумное', () => {
    expect(UNDATED_ALERT_HORIZON_DAYS).toBeGreaterThanOrEqual(3);
    expect(UNDATED_ALERT_HORIZON_DAYS).toBeLessThanOrEqual(30);
  });

  it('карточка, планировщик и форма берут его из одного модуля', () => {
    expect(read('lib/safety/alerts.ts')).toContain("from '@/lib/safety/alert-horizon'");
    expect(read('lib/planner/engine.ts')).toContain("from '@/lib/safety/alert-horizon'");
    expect(read('components/admin/ZoneAlertsPanel.tsx')).toContain('{UNDATED_ALERT_HORIZON_DAYS} суток');
    for (const f of ['lib/safety/alerts.ts', 'lib/planner/engine.ts']) {
      expect(read(f), `${f} завёл своё число`).not.toMatch(/UNDATED_ALERT_HORIZON_DAYS\s*=\s*\d/);
    }
  });

  it('и в карточке, и в планировщике меряется возраст самой тревоги', () => {
    expect(read('lib/safety/alerts.ts')).toMatch(/active_until IS NULL\s+AND active_from > NOW\(\) - make_interval\(days => \$2::int\)/);
    expect(read('lib/planner/engine.ts')).toMatch(/AND active_from > NOW\(\) - make_interval\(days => \$3::int\)/);
  });

  it('приёмник больше не обещает «до ручного снятия»', () => {
    expect(read('app/api/cron/safety-alert/route.ts')).not.toContain("'до ручного снятия'");
    expect(read('components/admin/ZoneAlertsPanel.tsx')).not.toContain('Срок неизвестен — снимем вручную');
  });
});
