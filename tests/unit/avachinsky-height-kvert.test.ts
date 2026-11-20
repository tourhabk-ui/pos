/**
 * Высота Авачинского — 2751 м по каталогу KVERT (ИВиС ДВО РАН), решение
 * владельца 21.11. 2741 м — из Википедии: только в оговорке, как у Толбачика.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LANDINGS } from '@/lib/landings/landings';

const ROOT = process.cwd();
const MIG = readFileSync(join(ROOT, 'migrations/1479_avachinsky_height_kvert.sql'), 'utf-8');

/** Пары replace из pg_temp.ava_2751 — та же функция, что применит база. */
function pairs(): Array<[string, string]> {
  const body = MIG.slice(MIG.indexOf('AS $$'), MIG.lastIndexOf('$$'));
  const lits = [...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < lits.length; i += 2) out.push([lits[i], lits[i + 1]]);
  return out;
}
const ava = (s: string) => pairs().reduce((t, [a, b]) => t.split(a).join(b), s);

/** «2741» рядом с Авачинским без оговорки KVERT/Википедии. */
const BARE = /Авачинск[^.\n|]{0,80}?2[\u00a0 ]?741(?![^(|\n]{0,40}по другим)|2[\u00a0 ]?741[^.\n]{0,15}Авачинск/;
const caveated = (s: string) => s.replace(/\(KVERT[^)]*\)|\([^)]*в Википедии — 2741 м[^)]*\)|\(региональный портал пишет 2741 м\)|в другом своём материале — 2741 м/g, '');

describe('Авачинский: 2751 м', () => {
  it('посадочные и летопись — 2751 м по KVERT, 2741 — только в оговорке', () => {
    const texts = [
      ...LANDINGS.map((l) => `${l.before}\n${l.after}`),
      readFileSync(join(ROOT, 'lib/chronicle/articles.ts'), 'utf-8'),
    ];
    for (const t of texts) expect(caveated(t)).not.toMatch(BARE);
    const all = texts.join('\n');
    expect(all).toContain('Авачинский высотой 2751 м по каталогу KVERT ИВиС ДВО РАН');
    expect(all).toContain('Авачинский, 2751 м (так в каталоге KVERT ИВиС ДВО РАН и на сайте парка; в Википедии — 2741 м)');
  });

  it('миграция 1479 переводит каждую фразу с 2741 из прежних миграций, повтор ничего не меняет', () => {
    const dir = join(ROOT, 'migrations');
    const older = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f) && parseInt(f) < 1479);
    let seen = 0;
    for (const f of older) {
      const sql = readFileSync(join(dir, f), 'utf-8');
      for (const m of sql.matchAll(/'((?:[^']|'')*)'/g)) {
        const s = m[1].replace(/''/g, "'");
        if (!/Авачинск/.test(s) || !/2[\u00a0 ]?741/.test(s)) continue;
        // 1473 — сама замена 2751→2741 в replace(): её «от» — 2751, «к» — 2741.
        seen++;
        const fixed = ava(s);
        expect(caveated(fixed), `${f}: ${s.slice(0, 120)}`).not.toMatch(BARE);
        expect(ava(fixed)).toBe(fixed);
      }
    }
    expect(seen).toBeGreaterThan(15);
    // Фраза 1473 и строка таблицы статьи с источником-Википедией [6].
    expect(ava('Его высота — 2741 метр')).toBe('Его высота — 2751 метр');
    expect(ava('| 2741 м (по другим данным 2717 м) [6] |'))
      .toBe('| 2751 м (KVERT ИВиС ДВО РАН; в Википедии — 2741 м, по другим данным 2717 м) [6] |');
  });

  it('высота в metadata маршрутов — только у Авачинского', () => {
    expect(MIG).toMatch(/metadata->>'height_m' = '2741' AND \(title ILIKE '%Авач%' OR description LIKE '%Авачинск%'\)/);
  });
});
