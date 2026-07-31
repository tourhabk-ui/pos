/**
 * Полоса активной поездки на главной — честность режима (коммит 5 редизайна).
 *
 * Правила из канонической спецификации:
 *   · источник — ТОЛЬКО auth-scoped GET /api/trips/active (identity из
 *     сессии; никакого id поездки из клиента);
 *   · рисуются только подтверждённые фазы during/before; after и unknown
 *     полосы не дают — UI не имеет права подменять unknown выдуманным днём;
 *   · «День N из M» — только из tripProgress (day/total), с проверками на
 *     null; никаких констант-дней в разметке;
 *   · плитки — только работающие входы (навигатор/радар/офлайн-карта),
 *     без «следующей точки»: связи день→точка в данных не существует.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
const code = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('полоса поездки: источник и гейт фаз', () => {
  it('данные — только из /api/trips/active', () => {
    expect(code).toContain("fetch('/api/trips/active'");
  });

  it('рисуются только during и before — allowlist, не blocklist', () => {
    expect(code, 'гейт фаз ослаблен — unknown/after могут дорисоваться')
      .toMatch(/phase === 'during' \|\| d\.progress\.phase === 'before'/);
    // after/unknown нигде не разрешаются к рендеру
    expect(code).not.toMatch(/phase === 'after'\s*&&\s*\(/);
  });

  it('«День N из M» защищён null-проверками и берётся из progress', () => {
    expect(code).toMatch(/phase === 'during' && trip\.progress\.day != null && trip\.progress\.total != null/);
    expect(code).toContain('День {trip.progress.day} из {trip.progress.total}');
  });

  it('в полосе нет выдуманных обещаний', () => {
    const strip = code.slice(code.indexOf('className="tripstrip"'), code.indexOf('I. РАДАР') > -1 ? code.indexOf('</section>', code.indexOf('className="tripstrip"')) : undefined);
    expect(strip).not.toMatch(/следующая точка|кордон/i);
    expect(strip).not.toMatch(/\d+\s*\/\s*\d+/); // дробей вида 12/16 нет
  });
});
