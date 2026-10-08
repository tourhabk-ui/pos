/**
 * «Тур ведёт расписание» — одно правило на все поверхности (08.10).
 *
 * Правило жило двумя копиями — в tourKeepsSchedule (запрос мест) и в SQL
 * каталога Кузьмича, — и третья понадобилась планеру. Разойдись они, планер
 * сказал бы «по заявке, все даты свободны», а get_tour_availability по тому
 * же туру — «расписание есть, мест нет». Сторож держит связку: правило одно,
 * его зовут все три потребителя, своей копии нет ни у кого.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { keepsScheduleSql } from '@/lib/tours/schedule';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('keepsScheduleSql', () => {
  it('будущая неотменённая неудалённая дата, «сегодня» — по Камчатке', () => {
    const sql = keepsScheduleSql('ot.id');
    expect(sql).toMatch(/^EXISTS \(/);
    expect(sql).toMatch(/FROM tour_availability ta_sched/);
    expect(sql).toMatch(/operator_tour_id = ot\.id/);
    expect(sql).toMatch(/date >= \(NOW\(\) AT TIME ZONE 'Asia\/Kamchatka'\)::date/);
    expect(sql).toMatch(/is_cancelled = FALSE/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(keepsScheduleSql('$1')).toMatch(/operator_tour_id = \$1/);
  });

  it('выражение тура — только колонка или параметр, не строка снаружи', () => {
    expect(() => keepsScheduleSql('1; DROP TABLE x')).toThrow();
    expect(() => keepsScheduleSql("ot.id OR '1'='1'")).toThrow();
    expect(() => keepsScheduleSql('')).toThrow();
  });
});

describe('потребители зовут общее правило', () => {
  it.each([
    ['lib/seat-requests/service.ts', /keepsScheduleSql\('\$1'\)/],
    ['lib/kuzmich/core.ts', /keepsScheduleSql\('ot\.id'\)/],
    ['lib/planner/data.ts', /NOT \$\{keepsScheduleSql\('ot\.id'\)\}/],
    ['lib/planner/data.ts', /keepsScheduleSql\('\$1'\)/],
  ])('%s', (file, call) => {
    expect(read(file)).toMatch(call);
  });

  it('своей копии условия нет нигде, кроме lib/tours/schedule.ts', () => {
    // Копия узнаётся по сочетанию: «сегодня по Камчатке» и «не отменена» в
    // одном запросе к tour_availability. Так выглядели обе прежние копии.
    const COPY = /Asia\/Kamchatka'\)::date\s+AND\s+(?:\w+\.)?is_cancelled = FALSE\s+AND\s+(?:\w+\.)?deleted_at IS NULL/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(process.cwd(), dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(process.cwd(), rel)).isDirectory()) { walk(rel); continue; }
        if (!/\.tsx?$/.test(name) || rel === 'lib/tours/schedule.ts') continue;
        if (COPY.test(read(rel))) offenders.push(rel);
      }
    };
    walk('lib');
    walk('app');
    expect(offenders).toEqual([]);
  });
});
