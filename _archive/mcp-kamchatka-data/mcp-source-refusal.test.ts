/**
 * Источник MCP умеет сказать «не смог», а не только «пусто».
 *
 * ── Что чинится (#1494, 01.09) ─────────────────────────────────────────────
 *
 * Находка эволюции назвала причиной пустой `catch` в `mches-telegram.ts`.
 * Причина неверна: пустого catch там нет — §4.0 прошёлся по этим файлам
 * раньше, и судья эволюции отметил это отдельно (#1428, «уже починено»).
 *
 * Но починка тогда дошла до ЛОГА и остановилась перед ТИПОМ. Все три
 * источника ловили отказ канала, писали `console.error` и возвращали
 * `unknown[]`. При отказе ВСЕХ каналов наверх уходил пустой массив, и
 * клиент MCP — в том числе Кузьмич, отвечающий человеку в поле, — не мог
 * отличить «МЧС молчит, всё тихо» от «t.me недоступен с хостинга».
 *
 * Лог уходит в контейнер Timeweb и не читается никем. Тип читают все
 * вызывающие. Третий исход обязан жить в типе.
 *
 * Сторож держит три вещи: что исход есть, что он считается честно (по
 * фактически спрошенным каналам) и что его не разворачивают обратно в
 * голый список по дороге к клиенту.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceResult } from '@/lib/mcp/kamchatka-data/sources/source-result';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SOURCES = ['mches-telegram', 'local-vk', 'tourism-db'] as const;
const SERVER = strip(read('lib/mcp/kamchatka-data/server.ts'));

describe('счёт отказа', () => {
  it('все каналы ответили — это не отказ', () => {
    expect(sourceResult([1, 2], [], 3).refused).toBe(false);
  });

  it('часть каналов молчит — ещё не отказ, но молчащие названы', () => {
    const r = sourceResult([1], [{ source: 'mches_pks', error: 'timeout' }], 3);
    expect(r.refused).toBe(false);
    expect(r.unavailable[0].source).toBe('mches_pks');
  });

  it('молчат все — пустой список значит «не смогли спросить»', () => {
    const fails = [
      { source: 'a', error: 'x' }, { source: 'b', error: 'y' }, { source: 'c', error: 'z' },
    ];
    const r = sourceResult([], fails, 3);
    expect(r.refused).toBe(true);
    expect(r.items).toHaveLength(0);
  });

  it('не спросили никого — тоже отказ, а не тишина', () => {
    // Источник без каналов не «пустой», он несобранный.
    expect(sourceResult([], [], 0).refused).toBe(true);
  });
});

describe('все три источника отвечают одинаково', () => {
  for (const name of SOURCES) {
    it(`${name}: возвращает SourceResult, а не голый массив`, () => {
      const code = strip(read(`lib/mcp/kamchatka-data/sources/${name}.ts`));
      expect(code, 'сигнатура осталась массивом').not.toMatch(/Promise<unknown\[\]>/);
      expect(code).toMatch(/Promise<SourceResult<unknown>>/);
      expect(code).toMatch(/return sourceResult\(/);
    });

    it(`${name}: отказ канала попадает и в лог, и в ответ`, () => {
      const code = strip(read(`lib/mcp/kamchatka-data/sources/${name}.ts`));
      // Лог остаётся: он нужен при разборе прода. Но одного его мало.
      expect(code).toMatch(/console\.error/);
      expect(code).toMatch(/unavailable\.push\(/);
    });
  }

  it('local-vk считает ФАКТИЧЕСКИ спрошенных: цикл выходит по лимиту', () => {
    // sources.length сказал бы, что мы спросили тех, кого не спрашивали, и
    // отказ бы не сработал никогда.
    const code = strip(read('lib/mcp/kamchatka-data/sources/local-vk.ts'));
    expect(code).toMatch(/asked \+= 1/);
    expect(code).toMatch(/sourceResult\(incidents\.slice\(0, limit\), unavailable, asked\)/);
  });
});

describe('до клиента отказ доходит', () => {
  it('сервер отдаёт весь ответ источника, а не .items', () => {
    // Разворачивание в голый список вернуло бы дефект целиком.
    expect(SERVER).not.toMatch(/\.items,\s*null,\s*2/);
    for (const v of ['alerts', 'incidents', 'objects']) {
      expect(SERVER, `${v} разворачивается в список`).toMatch(
        new RegExp(`JSON\\.stringify\\(${v}, null, 2\\)`),
      );
    }
  });
});
