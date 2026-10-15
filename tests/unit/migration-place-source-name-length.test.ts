/**
 * Подпись источника места помещается в свою колонку.
 *
 * `places.source_name` — varchar(100) (baseline прода). Длиннее — и
 * PostgreSQL отвечает 22001 «value too long», а миграция откатывается ЦЕЛИКОМ:
 * вместе с подписью не ложатся ни справки, ни переименования того же файла.
 * Так 15.10 упала бы 1264 (две подписи по 120+ знаков) — поймано локальной
 * базой до выката. Тот же род отказа, что у 1251 (уникальная пара источника):
 * правило схемы, которое видно только на настоящей базе, держится здесь
 * текстом — это запрет, а судит его, в конечном счёте, сама колонка.
 *
 * Предел читается из baseline, а не пишется числом: поменяют тип колонки —
 * сторож увидит новый предел, а не устаревший.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIR = join(ROOT, 'migrations');
const FROM = 1240;

function sourceNameLimit(): number {
  const baseline = readFileSync(join(ROOT, 'lib/database/baseline/schema-baseline.sql'), 'utf-8');
  const table = /CREATE TABLE IF NOT EXISTS places \(([\s\S]*?)\n\);/.exec(baseline)?.[1] ?? '';
  const m = /\bsource_name character varying\((\d+)\)/.exec(table);
  if (!m) throw new Error('в baseline не найден тип places.source_name');
  return Number(m[1]);
}

/** Буквальные подписи источника в правках places. */
function placeSourceNames(sql: string): string[] {
  const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const out: string[] = [];
  for (const stmt of body.split(/;\s*\n/)) {
    if (!/\b(UPDATE|INSERT INTO)\s+places\b/.test(stmt)) continue;
    for (const m of stmt.matchAll(/\bsource_name\s*=\s*(?:COALESCE\(\s*source_name\s*,\s*)?'((?:[^']|'')*)'/g)) {
      out.push(m[1].replace(/''/g, "'"));
    }
  }
  return out;
}

describe('подпись источника места помещается в колонку', () => {
  const limit = sourceNameLimit();

  it('предел взят из схемы', () => {
    expect(limit).toBe(100);
  });

  it(`миграции начиная с ${FROM} не пишут в places.source_name длиннее предела`, () => {
    const files = readdirSync(DIR).filter((f) => /^\d+_.*\.sql$/.test(f) && Number(f.split('_')[0]) >= FROM);
    const tooLong: string[] = [];
    let seen = 0;
    for (const f of files) {
      for (const name of placeSourceNames(readFileSync(join(DIR, f), 'utf-8'))) {
        seen++;
        if (name.length > limit) tooLong.push(`${f}: ${name.length} знаков — «${name.slice(0, 50)}…»`);
      }
    }
    // Детектор не слеп: подписи в этих миграциях есть, и он их видит.
    expect(seen).toBeGreaterThan(20);
    expect(tooLong).toEqual([]);
  });

  it('положительный контроль: длинную подпись детектор находит', () => {
    const sql = `UPDATE places\n   SET source_name = '${'к'.repeat(limit + 1)}',\n       updated_at = NOW()\n WHERE id::text = 'x';\n`;
    expect(placeSourceNames(sql).map((s) => s.length)).toEqual([limit + 1]);
  });
});
