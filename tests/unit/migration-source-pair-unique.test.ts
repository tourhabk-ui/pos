/**
 * Справки с одной страницы источника не сталкиваются на уникальном индексе.
 *
 * 14.10 миграция 1251 (пять справок Налычево вместо дневников) выехала с
 * деплоем и не легла: у видимых мест пара (source_name, source_url)
 * уникальна — idx_places_source_url_unique, защита от двойного импорта одной
 * записи, — а справки Авачинского вулкана и фумаролы Дзензура обе взяты со
 * страницы «Вулканы» кластера Налычево. Источник у обоих мест был пуст, и
 * COALESCE поставил им одну пару: вторая строка нарушила индекс, файл
 * откатился целиком, ни одна из пяти справок не легла (проба 892,
 * воспроизведено на локальной базе). Повтор — 1253.
 *
 * Сторож держит две вещи:
 *  - миграция, начиная с 1252, не ставит одну пару двум разным местам;
 *  - пара, которую она ставит, не совпадает с итоговой парой другого места
 *    из миграций со справками (с 1240).
 * COALESCE считается присвоением: у места без источника он им и станет.
 *
 * Проверка — по тексту миграций, потому что это запрет («двух одинаковых пар
 * быть не должно»), а судит его, в конечном счёте, сам индекс на проде.
 * Положительный контроль — 1251: детектор обязан найти в ней ту пару, на
 * которой она упала, иначе он слеп и его зелень ничего не значит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'migrations');
const FROM = 1240;
const GUARDED_FROM = 1252;

const strip = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

interface Assign { file: string; num: number; id: string; pair: string }

function assignments(file: string): Assign[] {
  const num = Number(file.split('_')[0]);
  const body = strip(readFileSync(join(DIR, file), 'utf-8'));
  const out: Assign[] = [];
  for (const stmt of body.split(/;\s*\n/)) {
    if (!/UPDATE places\b/.test(stmt)) continue;
    const id = /\bid::text\s*=\s*'([0-9a-f-]{36})'/.exec(stmt)?.[1];
    const name = /\bsource_name\s*=\s*(?:COALESCE\(\s*source_name\s*,\s*)?'((?:[^']|'')*)'/.exec(stmt)?.[1];
    const url = /\bsource_url\s*=\s*(?:COALESCE\(\s*source_url\s*,\s*)?'((?:[^']|'')*)'/.exec(stmt)?.[1];
    if (id && name && url) out.push({ file, num, id, pair: `${name} | ${url}` });
  }
  return out;
}

const FILES = readdirSync(DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f) && Number(f.split('_')[0]) >= FROM)
  .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
const ALL = FILES.flatMap(assignments);

/** Пары, которые одна миграция ставит разным местам. */
function intraFileCollisions(file: string): string[] {
  const byPair = new Map<string, Set<string>>();
  for (const a of assignments(file)) {
    const ids = byPair.get(a.pair) ?? new Set<string>();
    ids.add(a.id);
    byPair.set(a.pair, ids);
  }
  return [...byPair].filter(([, ids]) => ids.size > 1).map(([pair]) => pair);
}

/** Итоговая пара каждого места — из последней миграции, которая её ставит. */
function finalPairs(): Map<string, Assign> {
  const last = new Map<string, Assign>();
  for (const a of ALL) last.set(a.id, a);
  return last;
}

describe('пара (source_name, source_url) у разных мест не совпадает', () => {
  it('детектор видит пару, на которой упала 1251 (положительный контроль)', () => {
    const hits = intraFileCollisions('1251_nalychevo_diaries_whitespace_guard.sql');
    expect(hits).toEqual(['сайт парка «Вулканы Камчатки» | https://vulcanikamchatki.ru/territoriya/klaster_nalychevskij/vulkany/']);
  });

  it('с 1252 ни одна миграция не ставит одну пару двум местам', () => {
    const guarded = FILES.filter((f) => Number(f.split('_')[0]) >= GUARDED_FROM);
    expect(guarded).toContain('1252_yuzhno_kamchatsky_zakaznik.sql');
    expect(guarded).toContain('1253_nalychevo_diaries_unique_source.sql');
    for (const f of guarded) expect(intraFileCollisions(f), f).toEqual([]);
  });

  it('пара новой миграции не совпадает с итоговой парой другого места', () => {
    const final = finalPairs();
    const guarded = ALL.filter((a) => a.num >= GUARDED_FROM);
    expect(guarded.length).toBeGreaterThanOrEqual(10);
    for (const a of guarded) {
      const clash = [...final.values()].filter((b) => b.id !== a.id && b.pair === a.pair);
      expect(clash.map((b) => `${b.file}: ${b.id}`), `${a.file}: ${a.id}`).toEqual([]);
    }
  });
});
