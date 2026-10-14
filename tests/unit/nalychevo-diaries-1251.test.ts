/**
 * Вторая партия переписи дневников — повтор 1249 (миграция 1251).
 *
 * 1249 на проде не легла: проба 872 час ждала справку на Авачинском перевале
 * и видела пустое описание при снятом дневнике. 1247 узнавала дневник по
 * началу ПОСЛЕ обрезки ведущих пробелов, а в архив клала текст как есть; 1249
 * сравнивала архив без обрезки, и строка с переводом строки в начале не
 * совпадала. Сторож 1249 сверял начало с реестром 1247 — уже обрезанным — и
 * различия видеть не мог.
 *
 * Держится:
 *  - справки те же, что в 1249, слово в слово;
 *  - условие — то же выражение, которым 1247 узнала дневник: обрезка ведущих
 *    пробелов и первые 60 знаков, равные началу из реестра 1247;
 *  - после 1250 архив дневника не сравнивается голым LIKE ни в одной
 *    миграции: такое условие молча пропускает строку с пробелом в начале.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const strip = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const read = (f: string) => readFileSync(join(ROOT, 'migrations', f), 'utf-8');
const M1251 = strip(read('1251_nalychevo_diaries_whitespace_guard.sql'));
const M1249 = strip(read('1249_nalychevo_diaries_by_park_sources.sql'));
const M1247 = strip(read('1247_place_diary_descriptions_withdrawn.sql'));

const IDS = [
  '3dd2ceaf-1351-4625-9171-711eb8b1a455', // Авачинский перевал
  '32aa0d20-10d9-4fbb-a1f7-b90f327b7687', // Экструзия Верблюд
  '3a98a68d-76c8-4835-8d6d-24f7dd867cb8', // Вулкан Авачинский
  '4baebe00-d71b-4f53-b0bb-0f20b16f1747', // Краеведческие источники
  '05112df7-54f9-4280-bcd2-1bfe4929dfc0', // Фумарола вулкана Дзендзур
];

const statementOf = (body: string, id: string) =>
  body.split(/;\s*\n/).find((s) => /UPDATE places/.test(s) && s.includes(`'${id}'`) && /\n\s*description\s*=/.test(s))!;
/** Всё, что между SET и WHERE, — текст справки и её поля. */
const setPart = (stmt: string) => stmt.split(/\bSET\b/)[1].split(/\n\s*WHERE\b/)[0];
const headOf1247 = (id: string) =>
  new RegExp(`\\('${id}', '((?:[^']|'')*)'\\)`).exec(M1247)?.[1] ?? null;

describe('миграция 1251 — повтор 1249 с условием 1247', () => {
  it('справки те же, что в 1249, слово в слово', () => {
    for (const id of IDS) {
      const a = statementOf(M1251, id);
      const b = statementOf(M1249, id);
      expect(a, id).toBeTruthy();
      expect(setPart(a), id).toBe(setPart(b));
    }
  });

  it('дневник узнаётся тем же выражением, что в 1247: обрезка пробелов и 60 знаков начала', () => {
    expect(M1247).toMatch(/left\(regexp_replace\(p\.description, '\^\\s\+', ''\), 60\) = d\.head/);
    for (const id of IDS) {
      const s = statementOf(M1251, id);
      const head = headOf1247(id);
      expect(head, `${id}: в реестре 1247`).not.toBeNull();
      expect(s, id).toContain(`AND description IS NULL`);
      expect(s, id).toContain(`AND left(regexp_replace(description_withdrawn, '^\\s+', ''), 60) = '${head}'`);
    }
  });

  it('после 1250 архив дневника не сравнивается голым LIKE — так легла мимо 1249', () => {
    const later = readdirSync(join(ROOT, 'migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f) && Number(f.split('_')[0]) >= 1250);
    expect(later).toContain('1251_nalychevo_diaries_whitespace_guard.sql');
    for (const f of later) {
      expect(strip(read(f)), f).not.toMatch(/description_withdrawn\s+(I?LIKE|=)\s*'/);
    }
  });
});
