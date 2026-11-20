import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Сыщик 20.11: в плане июня день с туром на Горелый шёл под справкой вида
// «Восхождение на Авачинский…». Справка вида — только для дня без тура.
describe('описание дня плана', () => {
  it('у дня с туром — описание тура, а не справка вида', () => {
    const src = readFileSync(join(process.cwd(), 'lib/planner/engine.ts'), 'utf-8');
    expect(src).toContain("description: realTour ? (realTour.shortDescription ?? '') : (c.seasonNote ?? ''),");
    expect(src).not.toContain("description: realTour?.shortDescription ?? c.seasonNote ?? '',");
  });
});
