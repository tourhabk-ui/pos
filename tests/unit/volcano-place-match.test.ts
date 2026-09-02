/**
 * Вулкан KVERT находит свою точку в каталоге — иначе его нет на радаре.
 *
 * ── Что было сломано (02.09) ───────────────────────────────────────────────
 *
 * Владелец: «почему на радаре нет вулканов?». Слой есть, крон жив, KVERT
 * отдаёт 68 вулканов — сопоставлялось ВОСЕМЬ. Ключевской, с пепловым
 * выбросом до 6 км, был среди несопоставленных.
 *
 * Алиас `klyuchevskoy → «Ключевской»` работал. Падал поиск точки: он искал
 * имя, РАВНОЕ или НАЧИНАЮЩЕЕСЯ с русского имени, а в каталоге записано
 * «Вулкан Ключевская сопка». Приставка «Вулкан » ломала совпадение почти у
 * всех, у Ключевского вдобавок другая форма слова.
 *
 * Статус писался в базу без `place_ark_id`, а радар соединяет статус с
 * местом через него. Знание о работающем вулкане лежало в базе и не имело
 * способа попасть на экран.
 *
 * Числа и имена в этом файле — не выдуманные примеры: это живой ответ
 * `/api/cron/place-audit` с прода от 02.09.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  volcanoStem, buildVolcanoIndex, matchVolcanoPlace,
} from '@/lib/services/safety/volcano-match';
import { normalizeVolcanoName } from '@/lib/services/safety/kvert-vona';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Точки каталога, как они реально записаны на проде (проба 02.09). */
const PLACES = [
  { arkId: 'a1', name: 'Вулкан Ключевская сопка' },
  { arkId: 'a2', name: 'Вулкан Горелый' },
  { arkId: 'a3', name: 'Вулкан Кизимен (Щапинская сопка)' },
  { arkId: 'a4', name: 'Вулкан Кроноцкий (Кроноцкая сопка)' },
  { arkId: 'a5', name: 'Вулкан Ксудач' },
  { arkId: 'a6', name: 'Жупановский' },
  { arkId: 'a7', name: 'Опала' },
  { arkId: 'a8', name: 'Ичинский Вулкан' },
  { arkId: 'a9', name: 'Вулкан Плоский Толбачик' },
  { arkId: 'a10', name: 'Вулкан Острый Толбачик' },
  { arkId: 'a11', name: 'Вулкан Толбачик' },
];

const index = buildVolcanoIndex(PLACES);

describe('живой случай: имена KVERT против имён каталога', () => {
  // Пары «как зовёт KVERT» → «какая точка должна найтись».
  const CASES: Array<[string, string]> = [
    ['KLYUCHEVSKOY', 'Вулкан Ключевская сопка'],
    ['GORELY', 'Вулкан Горелый'],
    ['KIZIMEN', 'Вулкан Кизимен (Щапинская сопка)'],
    ['KRONOTSKY', 'Вулкан Кроноцкий (Кроноцкая сопка)'],
    ['KSUDACH', 'Вулкан Ксудач'],
    ['ZHUPANOVSKY', 'Жупановский'],
    ['OPALA', 'Опала'],
    ['ICHINSKY', 'Ичинский Вулкан'],
    ['PLOSKY TOLBACHIK', 'Вулкан Плоский Толбачик'],
  ];

  for (const [kvert, expected] of CASES) {
    it(`${kvert} → ${expected}`, () => {
      const norm = normalizeVolcanoName(kvert);
      expect(norm, `${kvert} нет в таблице алиасов`).not.toBeNull();
      const m = matchVolcanoPlace(index, norm!.ru);
      expect(m.kind, `${kvert}: ${JSON.stringify(m)}`).toBe('matched');
      if (m.kind === 'matched') expect(m.placeName).toBe(expected);
    });
  }
});

describe('основа имени', () => {
  it('родовые слова не различают: «Вулкан Горелый» = «Горелый»', () => {
    expect(volcanoStem('Вулкан Горелый')).toBe(volcanoStem('Горелый'));
  });

  it('уточнение в скобках не мешает', () => {
    expect(volcanoStem('Вулкан Кизимен (Щапинская сопка)')).toBe(volcanoStem('Кизимен'));
  });

  it('форма слова не мешает: «Ключевской» = «Ключевская сопка»', () => {
    expect(volcanoStem('Ключевской')).toBe(volcanoStem('Ключевская сопка'));
  });

  it('ё и е — одно и то же', () => {
    expect(volcanoStem('Жёлтовский')).toBe(volcanoStem('Желтовский'));
  });

  it('разные вулканы не схлопываются в одну основу', () => {
    // Главный риск стемминга: сделать из соседей одну запись и повесить код
    // не на тот конус.
    const stems = ['Горелый', 'Мутновский', 'Опала', 'Ксудач', 'Кизимен',
                   'Толбачик', 'Плоский Толбачик', 'Острый Толбачик',
                   'Авачинский', 'Корякский'].map(volcanoStem);
    expect(new Set(stems).size).toBe(stems.length);
  });
});

describe('неоднозначность — отказ, а не догадка', () => {
  it('несколько точек с одной основой: гадать нельзя', () => {
    const dup = buildVolcanoIndex([
      { arkId: 'x', name: 'Вулкан Опала' },
      { arkId: 'y', name: 'Опала' },
    ]);
    const m = matchVolcanoPlace(dup, 'Опала');
    expect(m.kind).toBe('ambiguous');
    if (m.kind === 'ambiguous') expect(m.candidates).toHaveLength(2);
  });

  it('места нет — это отдельный исход, не «не совпало»', () => {
    expect(matchVolcanoPlace(index, 'Штюбеля').kind).toBe('no_place');
  });

  it('опечатка в каталоге — тоже отказ, и смягчать сравнение нельзя', () => {
    // Первая проба 02.09 искала «Крашенин» и вернула 0 — я счёл, что записи
    // нет. Она есть: «Вулкан Крашенникова», без «ин». Строка «Крашенин» в
    // такое имя не входит, вот поиск и промолчал. «Не нашёл по этому
    // запросу» — не «нет в каталоге» (§4.0, и на этот раз про меня).
    //
    // Правило обязано отказать: основы разные. Чинится опечатка в данных.
    const typo = buildVolcanoIndex([{ arkId: 'k', name: 'Вулкан Крашенникова' }]);
    expect(matchVolcanoPlace(typo, 'Крашенинников').kind).toBe('no_place');
    // А после исправления имени — находится.
    const fixed = buildVolcanoIndex([{ arkId: 'k', name: 'Вулкан Крашенинникова' }]);
    expect(matchVolcanoPlace(fixed, 'Крашенинников').kind).toBe('matched');
  });
});

describe('синк называет причину отказа, а не сваливает в один список', () => {
  const SYNC = strip(read('lib/agents/kvert-sync.ts'));

  it('четыре причины названы порознь', () => {
    for (const r of ['unknown_name', 'no_place', 'ambiguous', 'failed']) {
      expect(SYNC, `нет причины ${r}`).toContain(r);
    }
  });

  it('отказ записи логируется, а не выдаётся за отсутствие места', () => {
    expect(SYNC).toMatch(/console\.error\(`\[kvert-sync\]/);
    expect(SYNC).toMatch(/reasons\.failed\.push/);
  });

  it('указатель каталога строится один раз, а не запросом на вулкан', () => {
    expect(SYNC).toMatch(/const index = await loadVolcanoIndex\(\)/);
    expect(SYNC).not.toMatch(/await resolvePlaceArkId/);
  });

  it('ручная правка ищет место тем же указателем', () => {
    // Два способа найти место разошлись бы, и админ привязывал бы не туда.
    const at = SYNC.indexOf('export async function setVolcanoAcc');
    expect(at).toBeGreaterThan(0);
    expect(SYNC.slice(at, at + 900)).toMatch(/matchVolcanoPlace\(await loadVolcanoIndex\(\)/);
  });
});

describe('пустой радар не выдаётся за спокойный', () => {
  const DATA = strip(read('app/_home/data.ts'));

  it('опасный код без привязки к точке помечает круг неполным', () => {
    expect(DATA).toMatch(/place_ark_id IS NULL/);
    const at = DATA.indexOf('place_ark_id IS NULL');
    expect(DATA.slice(at, at + 400)).toMatch(/degraded = true/);
  });

  it('не сосчитали непривязанные — тоже неполно, а не «чисто»', () => {
    expect(DATA).toMatch(/непривязанные коды не сосчитались/);
  });
});
