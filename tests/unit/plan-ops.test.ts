/**
 * Общие правила правки дней плана (#2224, шаг 2): кнопки веб-планера и
 * edit_trip_plan судят одним модулем, lib/planner/plan-ops.
 *
 * До этого у кнопок были свои правила: «удалить» снимало переезд между
 * зонами и середину многодневного тура, «добавить маршрут днём» ставило
 * день после отъезда, перетаскивание уносило прилёт в середину поездки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameReason, tourGroup, insertIndex, orderProblem } from '@/lib/planner/plan-ops';

type D = { day: number; type: string; title: string; realTour?: { tourId: string } | null };
const d = (day: number, type: string, title = `д${day}`, tourId?: string): D =>
  ({ day, type, title, ...(tourId ? { realTour: { tourId } } : {}) });

const PLAN: D[] = [
  d(1, 'arrival'), d(2, 'activity', 'Вулкан'), d(3, 'travel'),
  d(4, 'activity', 'Рыбалка, день 1', 'fish'), d(5, 'activity', 'Рыбалка — день 2 из 2', 'fish'),
  d(6, 'rest'), d(7, 'departure'),
];

describe('правила', () => {
  it('каркас поездки не трогается, остальное — можно', () => {
    expect(frameReason({ type: 'arrival' })).toBe('день прилёта');
    expect(frameReason({ type: 'departure' })).toBe('день отъезда');
    expect(frameReason({ type: 'travel' })).toBe('переезд между зонами');
    for (const t of ['activity', 'rest', 'buffer']) expect(frameReason({ type: t })).toBeNull();
  });

  it('многодневный тур — одной группой', () => {
    expect(tourGroup(PLAN, PLAN[3]).map((x) => x.day)).toEqual([4, 5]);
    expect(tourGroup(PLAN, PLAN[1]).map((x) => x.day)).toEqual([2]);
  });

  it('новый день — перед отъездом; отъезда нет — в конец', () => {
    expect(insertIndex(PLAN)).toBe(6);
    expect(insertIndex(PLAN.filter((x) => x.type !== 'departure'))).toBe(6);
  });

  it('порядок: прилёт первым, отъезд последним, тур не разрывается', () => {
    expect(orderProblem(PLAN)).toBeNull();
    expect(orderProblem([PLAN[1], PLAN[0], ...PLAN.slice(2)])).toMatch(/прилёта остаётся первым/);
    expect(orderProblem([...PLAN.slice(0, 5), PLAN[6], PLAN[5]])).toMatch(/отъезда остаётся последним/);
    expect(orderProblem([PLAN[0], PLAN[1], PLAN[3], PLAN[5], PLAN[4], PLAN[2], PLAN[6]])).toMatch(/не разрывают/);
    // Перестановка обычных дней — годится.
    expect(orderProblem([PLAN[0], PLAN[5], PLAN[1], PLAN[2], PLAN[3], PLAN[4], PLAN[6]])).toBeNull();
  });
});

describe('одна функция на обе двери', () => {
  const UI = readFileSync(join(process.cwd(), 'app/planner/_PlannerClient.tsx'), 'utf-8');
  const EDIT = readFileSync(join(process.cwd(), 'lib/planner/plan-edit.ts'), 'utf-8');
  const OPS = readFileSync(join(process.cwd(), 'lib/planner/plan-ops.ts'), 'utf-8');

  it('модуль правил годится для браузера: ни базы, ни движка', () => {
    expect(OPS).not.toMatch(/^import (?!type )/m);
  });

  it('диалог берёт правила из plan-ops, своих копий нет', () => {
    expect(EDIT).toMatch(/import \{[^}]*tourGroup[^}]*insertIndex[^}]*\} from '\.\/plan-ops'/);
    expect(EDIT).not.toMatch(/function tourGroup|const FRAME_WORD|new Set\(\['activity', 'rest', 'buffer'\]\)/);
  });

  it('кнопки планера судят теми же правилами', () => {
    expect(UI).toMatch(/import \{ frameReason, tourGroup, insertIndex, orderProblem \} from '@\/lib\/planner\/plan-ops'/);
    const fn = (name: string) => UI.slice(UI.indexOf(`function ${name}(`), UI.indexOf('\n  }\n', UI.indexOf(`function ${name}(`)));
    expect(fn('deleteDay')).toMatch(/frameReason\(target\)/);
    expect(fn('deleteDay')).toMatch(/tourGroup\(days, target\)/);
    expect(fn('replaceDay')).toMatch(/frameReason\(target\)/);
    expect(fn('addRouteAsDay')).toMatch(/insertIndex\(prev\)/);
    expect(fn('addDay')).toMatch(/insertIndex\(prev\)/);
    // Маршрут больше не дописывается в конец, после дня отъезда.
    expect(fn('addRouteAsDay')).not.toMatch(/return \[\.\.\.prev, routeToDayPlan/);
    expect(UI).toMatch(/const broken = orderProblem\(newDays\);\s*if \(broken\) \{ setEditNote\(broken\); return; \}/);
  });

  it('отказ виден на экране плана, а не в панели шагов анкеты', () => {
    expect(UI).toMatch(/\{editNote && \(\s*<p role="status"/);
  });
});
