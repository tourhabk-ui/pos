/**
 * Проверка «лежат ли тайлы в телефоне» живёт в одном месте и судит строго.
 *
 * ── Повод (20.09) ─────────────────────────────────────────────────────────
 *
 * Правило было реализовано трижды, и все три копии сходились в одном:
 *
 *   lib/offline/useOfflineRegion.ts  проба [первый, средний, последний] + some
 *   lib/offline/field-pack.ts        тот же some по переданным адресам
 *   app/planning/_PlanningClient.tsx та же тройка, собранная руками
 *
 * `hits.some(...)` значит «хоть один адрес на месте». При пробе из трёх
 * адресов это читается так: две трети карты могут быть вычищены, а полевой
 * пакет пройдёт как готовый. Узнаёт об этом человек в поле — там, где
 * исправить уже нечем.
 *
 * Четвёртое место не судило вовсе: экран планирования рисовал зелёную
 * галочку «Карта сохранена» прямо из записи в localStorage, а чек-лист
 * готовности ставил от неё же галочку «Маршрут сохранён офлайн». Запись и
 * тайлы живут в разных хранилищах, и система чистит одно, не трогая другое.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 *  - приговор строгий: `present` только когда на месте ВСЯ проба;
 *  - «спросить нечем» — отдельный исход, а не `present` (§4.0);
 *  - проба идёт равным шагом по всему списку, а не подряд и не тройкой;
 *  - `caches.match` в офлайн-контуре зовётся из одного файла;
 *  - потребители не собирают свою пробу и не заводят своего предиката.
 *
 * ЧЕГО ОН НЕ ДЕРЖИТ: слов, которыми о пропаже сообщают регион, полевой пакет
 * и карта маршрута. Контексты разные, и общий текст пришлось бы писать так
 * обобщённо, что он перестал бы что-либо значить.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  sampleTileUrls, judgeTilesPresence, probeTilesPresent, presenceRatio,
  TILE_PROBE_SIZE,
} from '@/lib/offline/tiles-present';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
/** Комментарии вырезаны: сторож не должен краснеть на словах о прежнем дефекте. */
const code = (src: string) =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SOURCE = 'lib/offline/tiles-present.ts';
const CONSUMERS = [
  'lib/offline/useOfflineRegion.ts',
  'lib/offline/field-pack.ts',
  'app/planning/_PlanningClient.tsx',
];

describe('приговор строгий', () => {
  it('present — только когда на месте вся проба', () => {
    expect(judgeTilesPresence(12, 12).state).toBe('present');
  });

  it('один уцелевший из двенадцати — это partial, а НЕ present', () => {
    // Ровно тот случай, который прежний `hits.some(...)` объявлял готовностью.
    expect(judgeTilesPresence(12, 1).state).toBe('partial');
    expect(judgeTilesPresence(12, 11).state).toBe('partial');
  });

  it('не нашлось ничего — missing', () => {
    expect(judgeTilesPresence(12, 0).state).toBe('missing');
  });

  it('спросить было нечего — unknown, и это не present', () => {
    const p = judgeTilesPresence(0, 0);
    expect(p.state).toBe('unknown');
    expect(p.state).not.toBe('present');
  });

  it('итог несёт числа, а не только слово', () => {
    expect(judgeTilesPresence(12, 4)).toEqual({ state: 'partial', checked: 12, found: 4 });
    expect(presenceRatio(judgeTilesPresence(12, 3))).toBeCloseTo(0.25);
  });

  it('доля при непроверенном — null, а не ноль', () => {
    // Ноль читался бы как «ничего нет» — то есть непроверенность выдавалась
    // бы за измеренную пропажу.
    expect(presenceRatio(judgeTilesPresence(0, 0))).toBeNull();
  });
});

describe('проба берётся по всему списку', () => {
  const urls = Array.from({ length: 400 }, (_, i) => `https://tile/${i}.png`);

  it('список короче пробы — берётся целиком', () => {
    expect(sampleTileUrls(['a', 'b'], 12)).toEqual(['a', 'b']);
  });

  it('пустой список и нулевой размер — пустая проба', () => {
    expect(sampleTileUrls([], 12)).toEqual([]);
    expect(sampleTileUrls(urls, 0)).toEqual([]);
  });

  it('берётся ровно столько, сколько просили', () => {
    expect(sampleTileUrls(urls)).toHaveLength(TILE_PROBE_SIZE);
  });

  it('проба достаёт до обоих концов', () => {
    const s = sampleTileUrls(urls);
    expect(s[0]).toBe(urls[0]);
    expect(s[s.length - 1]).toBe(urls[urls.length - 1]);
  });

  it('шаг равномерный — не десяток подряд с одного участка карты', () => {
    // Соседние тайлы это соседние квадраты на земле: они пропадают вместе, и
    // проба подряд меряет один участок вместо всей карты.
    const idx = sampleTileUrls(urls).map((u) => urls.indexOf(u));
    const gaps = idx.slice(1).map((v, i) => v - idx[i]);
    expect(Math.min(...gaps)).toBeGreaterThan(1);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('каждый из четырёх зумов коридора попадает в пробу', () => {
    // Прежняя тройка [первый, средний, последний] оставляла целый зум
    // непроверенным: список идёт блоками по зумам.
    const byZoom = [12, 13, 14, 15].flatMap((z) =>
      Array.from({ length: 100 }, (_, i) => `https://tile/${z}/${i}/0.png`));
    const zooms = new Set(sampleTileUrls(byZoom).map((u) => u.split('/')[3]));
    expect(zooms).toEqual(new Set(['12', '13', '14', '15']));
  });

  it('повторы в пробу дважды не попадают', () => {
    const s = sampleTileUrls(['a', 'a', 'a', 'a', 'a'], 3);
    expect(s).toEqual(['a']);
  });
});

describe('обращение к хранилищу', () => {
  const original = Reflect.getOwnPropertyDescriptor(globalThis, 'caches');
  const setCaches = (value: unknown) => {
    Object.defineProperty(globalThis, 'caches', { value, configurable: true, writable: true });
  };

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'caches', original);
    else Reflect.deleteProperty(globalThis, 'caches');
  });

  it('нет Cache Storage (SSR, приватный режим) — unknown', async () => {
    setCaches(undefined);
    expect((await probeTilesPresent(['https://tile/1.png'])).state).toBe('unknown');
  });

  it('хранилище отказало — unknown, а не missing', async () => {
    // Отказ обращения это «не смогли спросить». Объявить по нему пропажу
    // значило бы гнать человека перекачивать целую карту на ровном месте.
    setCaches({ match: () => Promise.reject(new Error('отказ')) });
    expect((await probeTilesPresent(['https://tile/1.png'])).state).toBe('unknown');
  });

  it('всё на месте — present', async () => {
    setCaches({ match: () => Promise.resolve(new Response('')) });
    const p = await probeTilesPresent(Array.from({ length: 50 }, (_, i) => `https://tile/${i}.png`));
    expect(p.state).toBe('present');
    expect(p.checked).toBe(TILE_PROBE_SIZE);
  });

  it('часть пропала — partial, и числа названы', async () => {
    let n = 0;
    setCaches({ match: () => Promise.resolve(n++ % 2 === 0 ? new Response('') : undefined) });
    const p = await probeTilesPresent(Array.from({ length: 50 }, (_, i) => `https://tile/${i}.png`));
    expect(p.state).toBe('partial');
    expect(p.found).toBeLessThan(p.checked);
    expect(p.found).toBeGreaterThan(0);
  });

  it('не нашлось ничего — missing', async () => {
    setCaches({ match: () => Promise.resolve(undefined) });
    expect((await probeTilesPresent(['https://tile/1.png'])).state).toBe('missing');
  });

  it('адресов нет вовсе — unknown, а не missing', async () => {
    // Запись, сделанная до 20.09, пробы не несёт. «Нечего спросить» не равно
    // «карты нет»: иначе старая запись читалась бы как пропажа.
    setCaches({ match: () => Promise.resolve(new Response('')) });
    expect((await probeTilesPresent([])).state).toBe('unknown');
  });
});

describe('правило живёт в одном месте', () => {
  it('caches.match в офлайн-контуре зовётся только из общего источника', () => {
    const offenders = readdirSync(join(process.cwd(), 'lib/offline'))
      .filter((f) => f.endsWith('.ts') && `lib/offline/${f}` !== SOURCE)
      .filter((f) => /caches\.match/.test(code(read(`lib/offline/${f}`))));
    expect(offenders, `своя проверка кэша: ${offenders.join(', ')}`).toEqual([]);
  });

  it('прежнего слабого предиката не осталось ни у кого', () => {
    for (const f of CONSUMERS) {
      expect(code(read(f)), `${f}: предикат «хоть один на месте» вернулся`)
        .not.toMatch(/hits\s*\.\s*some\s*\(/);
    }
  });

  it('локальной копии sampleTilesPresent больше нет', () => {
    for (const f of CONSUMERS) {
      expect(code(read(f)), `${f}: копия правила вернулась`)
        .not.toMatch(/function\s+sampleTilesPresent/);
    }
  });

  it('проба пакета не собирается тройкой руками', () => {
    // Было: [urls[0], urls[Math.floor(urls.length / 2)], urls[urls.length - 1]]
    expect(code(read('app/planning/_PlanningClient.tsx')))
      .not.toMatch(/urls\[Math\.floor\([^)]*length\s*\/\s*2\)\]/);
  });

  it('каждый потребитель берёт правило из общего файла', () => {
    for (const f of CONSUMERS) {
      expect(read(f), `${f}: не импортирует общий источник`)
        .toContain("from '@/lib/offline/tiles-present'");
    }
  });
});

describe('запись о карте несёт, чем себя проверить', () => {
  const SAVED = read('lib/offline/saved-map.ts');

  it('в записи есть проба адресов', () => {
    expect(SAVED).toMatch(/sampleUrls:\s*string\[\]/);
  });

  it('у записи без пробы поле пустое, а не выдуманное', () => {
    expect(code(SAVED)).toMatch(/Array\.isArray\(d\.sampleUrls\)/);
  });

  it('шапка больше не обещает, что проверки наличия нет', () => {
    // Докстрока, описывающая несуществующее положение дел, — дефект кода
    // (§10.09), а не деталь документации.
    expect(SAVED).not.toContain('Проверка наличия — отдельный разговор');
  });
});
