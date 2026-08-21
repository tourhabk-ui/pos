/**
 * Коридор полевого экрана — честность (финал по ведущему кандидату, 21.08).
 *
 * Коридор строится только из route_waypoints и только вперёд от следующей
 * точки; отрезки — по прямой, и подпись говорит это словами; пустота не
 * заполняется.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const corridorSrc = readFileSync(
  join(process.cwd(), 'components/field/FieldCorridor.tsx'), 'utf-8',
);
const clientSrc = readFileSync(
  join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8',
);

describe('FieldCorridor', () => {
  it('пустой коридор не рендерится вовсе', () => {
    expect(corridorSrc).toMatch(/if \(items\.length === 0\) return null/);
  });

  it('мера отрезков названа словами', () => {
    expect(corridorSrc).toContain('по прямой между точками');
  });

  it('клиент строит коридор от точки ПОСЛЕ следующей и не выдумывает событий', () => {
    expect(clientSrc).toMatch(/waypoints\.slice\(currentWpIdx \+ 1, currentWpIdx \+ 3\)/);
  });

  it('при конфликте данных коридора нет, как и прогресса', () => {
    expect(clientSrc).toMatch(/corridorItems\.length > 0 && !approach\?\.dataConflict/);
  });
});
