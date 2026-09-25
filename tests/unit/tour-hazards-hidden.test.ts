/**
 * Опасность, скрытая на туре решением владельца (миграция 1013).
 *
 * Тур 27 «Сплав по реке Быстрая» описан как сплав «без опасных порогов», а
 * вывод из типа активности (rafting) рисовал «Речные пороги». Владелец
 * 25.09: «скрой пороги у тура 27». Держит связку: правило скрывает из любого
 * источника и только названное; роут читает колонку тура и передаёт её в
 * обе функции; миграция скрывает именно rapids и только у сплава 27.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHazardSignals } from '@/lib/safety/hazard-signals';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const kinds = (h?: string[]) =>
  getHazardSignals({ activity_type: 'rafting', operator_tour: true, hidden_hazards: h }).map((s) => s.hazard);

describe('hidden_hazards', () => {
  it('без скрытых — пороги есть (вывод из rafting не сломан)', () => {
    expect(kinds()).toContain('rapids');
  });

  it('скрыт rapids — порогов нет, вода и медведи остались', () => {
    const k = kinds(['rapids']);
    expect(k).not.toContain('rapids');
    expect(k).toContain('water');
    expect(k).toContain('wildlife');
  });

  it('скрывает и то, что пришло из профиля маршрута', () => {
    const k = getHazardSignals({ hazard_types: ['rapids'], hidden_hazards: ['rapids'] }).map((s) => s.hazard);
    expect(k).not.toContain('rapids');
  });

  it('неизвестное имя ничего не ломает', () => {
    expect(kinds(['нет-такого'])).toEqual(kinds());
  });
});

describe('связка', () => {
  const route = read('app/api/safety/warnings/route.ts');
  const mig = read('migrations/1013_operator_tours_hazards_hidden.sql');

  it('роут читает колонку тура и отдаёт её в обе функции', () => {
    expect(route).toMatch(/ot\.hazards_hidden/);
    expect(route.match(/hidden_hazards: routeInfo\.hazards_hidden/g)?.length).toBe(2);
  });

  it('миграция скрывает только rapids и только у сплава 27', () => {
    expect(mig).toMatch(/SET hazards_hidden = ARRAY\['rapids'\]/);
    expect(mig).toMatch(/WHERE id = 27\s+AND activity_type = 'rafting'/);
  });
});
