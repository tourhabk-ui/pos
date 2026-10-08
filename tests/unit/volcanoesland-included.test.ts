/**
 * Подробный состав туров «Края Вулканов» (миграция 1178, #2245).
 *
 * Состав и программа живут в разных полях, и расходиться им нельзя: строка
 * «питание по программе: N завтраков…» обязана совпадать со счётом по дням
 * программы из 1176, иначе на одной карточке две версии одного тура (тот же
 * довод, что у tour-content-no-duplication). Сторож держит и защиту правок
 * оператора: обновляется только состав, равный положенному в 1176.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const T1176 = readFileSync(join(ROOT, 'migrations/1176_volcanoesland_tours.sql'), 'utf-8');
const T1178 = readFileSync(join(ROOT, 'migrations/1178_volcanoesland_tours_included_detail.sql'), 'utf-8');
const CODE = T1178.replace(/--[^\n]*/g, '');

/** Программа каждого тура из 1176: slug → тексты дней. */
function programs(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const body = T1176.slice(T1176.indexOf('CROSS JOIN (VALUES'), T1176.indexOf(') AS v(title, slug'));
  for (const row of body.split(/\n  \(/).slice(1)) {
    const slug = /^'[^']*', '([a-z0-9-]+)'/.exec(row)![1];
    const json = /'(\[.*\])'::jsonb/s.exec(row)![1].replace(/''/g, "'");
    out.set(slug, (JSON.parse(json) as Array<{ text: string }>).map((d) => d.text));
  }
  return out;
}

/** Строки 1178: slug → [включено, не входит]. */
function rows(): Map<string, [string[], string[]]> {
  const out = new Map<string, [string[], string[]]>();
  const body = CODE.slice(CODE.indexOf('FROM (VALUES'), CODE.indexOf(') AS v(slug'));
  for (const row of body.split(/\n  \(/).slice(1)) {
    const slug = /^'([a-z0-9-]+)'/.exec(row)![1];
    const arrays = [...row.matchAll(/ARRAY\[(.*?)\]::text\[\]/gs)].map((m) =>
      [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")));
    out.set(slug, [arrays[0], arrays[1]]);
  }
  return out;
}

describe('миграция 1178: подробный состав туров «Края Вулканов»', () => {
  const prog = programs();
  const r = rows();

  it('все 11 туров из 1176, состав не пустой и подробнее прежнего', () => {
    expect([...r.keys()].sort()).toEqual([...prog.keys()].sort());
    for (const [slug, [inc]] of r) {
      expect(inc.length, slug).toBeGreaterThanOrEqual(5);
      expect(inc.some((s) => /^проживание: |^вертолётный перелёт/.test(s)), slug).toBe(true);
    }
  });

  it('счёт завтраков, обедов и ужинов совпадает с кодами дней программы', () => {
    for (const [slug, days] of prog) {
      const meals = days.map((d) => /Питание: ([^.]+)\./.exec(d)?.[1] ?? '');
      const want = {
        b: meals.filter((m) => m.includes('завтрак')).length,
        o: meals.filter((m) => m.includes('обед')).length,
        u: meals.filter((m) => m.includes('ужин')).length,
      };
      if (want.b + want.o + want.u === 0) continue; // круиз и однодневная экскурсия — без счёта по дням
      const line = r.get(slug)![0].find((s) => s.startsWith('питание по программе:'));
      expect(line, slug).toBeDefined();
      const n = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(line!)?.[1] ?? 0);
      expect({ b: n('завтрак'), o: n('обед'), u: n('ужин') }, slug).toEqual(want);
      if (want.u === 0) expect(r.get(slug)![1], slug).toContain('ужины');
    }
  });

  it('пишется только поверх состава из 1176 — правки оператора не затираются', () => {
    expect(CODE).toMatch(/AND t\.included IS NOT DISTINCT FROM v\.old_inc/);
    expect(CODE).toMatch(/AND t\.not_included IS NOT DISTINCT FROM v\.old_ninc/);
    expect(CODE).toMatch(/t\.operator_id::text = p\.id::text/);
    expect(CODE).not.toMatch(/INSERT INTO|DELETE FROM/);
  });

  it('перелёт до Камчатки — «не входит» ровно там, где тур начинается в аэропорту или с прибытия', () => {
    for (const [slug, [, ninc]] of r) {
      const first = prog.get(slug)![0];
      const startsOnArrival = /аэропорт|Прибытие/i.test(first);
      const claims = ninc.some((s) => s.startsWith('авиаперелёт до Петропавловска-Камчатского'));
      expect(claims, slug).toBe(startsOnArrival);
    }
  });
});
