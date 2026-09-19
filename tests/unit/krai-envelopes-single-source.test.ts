/**
 * Конверты Камчатки объявлены в ОДНОМ месте.
 *
 * ── Случай 19.09 (#1961) ───────────────────────────────────────────────────
 *
 * Находка разведки говорила, что в парсере треков нет проверки на
 * принадлежность к краю. Проверка там есть, и строже предложенной: судится
 * КАЖДАЯ точка, а порядок осей не угадывается, а проверяется. Зато рядом
 * нашлось другое: конвертов края в репозитории было ТРИ, они не совпадали, и
 * два носили одно и то же имя `KAMCHATKA_BOUNDS`.
 *
 *   lib/geo/krai-envelope.ts   50 – 65.5   155 – 174   приёмник SOS, правка мест
 *   lib/services/routes/geocode.ts  50 – 64   155 – 167   геокодер, сверки, ремонт
 *   lib/routes/track.ts        50 – 66     154 – 175   импорт трека, полевой контур
 *
 * Следствие проверяется по коду, а не рассуждением: сигнал SOS с точки 65°с.ш.
 * принимается, а наблюдение туриста оттуда же отвергается с текстом
 * «координаты вне Камчатки». Платформа не согласна сама с собой в том, где
 * кончается край, и один из спорящих — путь SOS.
 *
 * Отдельная ирония: `lib/geo/krai-envelope.ts` заведён РОВНО чтобы этого не
 * было. В его шапке написано: «скопировать четыре числа значило бы завести
 * второе правило (§12)». Два других конверта существовали независимо от него.
 *
 * ── Конвертов оказалось ЧЕТЫРЕ ─────────────────────────────────────────────
 *
 * Три были найдены глазами, по имени. Четвёртый — `BBOX` в
 * `lib/services/ingest/osm-traces-scout.ts` — нашёлся на ПЕРВОМ прогоне этого
 * сторожа, и поиском по имени не нашёлся бы никогда: он не носит ни слова
 * «Камчатка», ни `KAMCHATKA_BOUNDS`. Числа в нём совпадали с геокодерными
 * посимвольно, то есть он был безвреден ровно до первой правки геокодера —
 * после которой разошёлся бы молча.
 *
 * Это и есть довод в пользу сторожа вместо разовой уборки: уборка убирает то,
 * что видно, а расходятся копии, которых не видно.
 *
 * ── Что держит этот сторож и чего он НЕ держит ─────────────────────────────
 *
 * Держит: все конверты Камчатки объявлены в `lib/geo/krai-envelope.ts`, и
 * четвёртый не заведётся молча — литерал bbox края в любом другом файле
 * краснеет.
 *
 * НЕ держит: равенство чисел. Они разные не случайно — поле трека шире
 * намеренно, геокодер уже намеренно, — и свести их в один набор значит
 * изменить, какие координаты платформа считает своими. На пути SOS это
 * решение владельца, и сторож, требующий одинаковых чисел, принял бы это
 * решение за него.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  GEOCODE_ENVELOPE,
  TRACK_ENVELOPE,
  KRAI_LAT_MIN,
  KRAI_LAT_MAX,
  KRAI_LNG_MIN,
  KRAI_LNG_MAX,
} from '@/lib/geo/krai-envelope';
import { KAMCHATKA_BOUNDS, withinKamchatka } from '@/lib/services/routes/geocode';
import { isPlausibleTrackPoint } from '@/lib/routes/track';

const HOME = 'lib/geo/krai-envelope.ts';

function sources(): string[] {
  const out = execSync(
    "git ls-files 'lib/**/*.ts' 'app/**/*.ts' 'app/**/*.tsx' 'hooks/**/*.ts' 'scripts/**/*.ts'",
    { encoding: 'utf-8', cwd: process.cwd() },
  );
  return out.split('\n').filter(Boolean).filter((f) => !f.includes('/tests/') && !f.endsWith('.test.ts'));
}

/**
 * Литерал конверта: объект с границами широты и долготы в одной строке.
 * Ищется форма, которой все три конверта и были записаны.
 */
const ENVELOPE_LITERAL = /\{\s*lat(Min|_min)\s*:\s*-?\d+(\.\d+)?\s*,[^}]*lng(Min|_min)\s*:/i;

describe('конверт края объявляется в одном файле', () => {
  const files = sources();

  it('исходники найдены', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('ни один другой файл не объявляет свой bbox Камчатки', () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f === HOME) continue;
      readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
        if (ENVELOPE_LITERAL.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      bad,
      `конверт края объявляется только в ${HOME}: четвёртый набор чисел ` +
      'разойдётся с тремя существующими так же молча, как разошлись они',
    ).toEqual([]);
  });

  it('сторож ловит именно ту форму, которой конверты и были записаны', () => {
    expect(ENVELOPE_LITERAL.test("const KAMCHATKA_BOUNDS = { latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 };")).toBe(true);
    expect(ENVELOPE_LITERAL.test("export const TRACK_ENVELOPE = { latMin: 50, latMax: 66, lngMin: 154, lngMax: 175 } as const;")).toBe(true);
    // А объект без долготы конвертом не считается — иначе краснело бы всё.
    expect(ENVELOPE_LITERAL.test("const box = { latMin: 50, latMax: 64 };")).toBe(false);
    expect(ENVELOPE_LITERAL.test("const p = { lat: 53.0, lng: 158.6 };")).toBe(false);
  });
});

describe('переезд ничего не сдвинул: числа те же, что были до 19.09', () => {
  it('конверт геокодера', () => {
    expect(GEOCODE_ENVELOPE).toEqual({ latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 });
    expect(KAMCHATKA_BOUNDS).toBe(GEOCODE_ENVELOPE);
  });

  it('конверт парсера трека', () => {
    expect(TRACK_ENVELOPE).toEqual({ latMin: 50, latMax: 66, lngMin: 154, lngMax: 175 });
  });

  it('конверт края (путь SOS и правка координат мест)', () => {
    expect([KRAI_LAT_MIN, KRAI_LAT_MAX, KRAI_LNG_MIN, KRAI_LNG_MAX]).toEqual([50.0, 65.5, 155.0, 174.0]);
  });

  it('поведение потребителей не изменилось', () => {
    // Петропавловск проходит везде.
    expect(withinKamchatka(53.04, 158.65)).toBe(true);
    expect(isPlausibleTrackPoint(53.04, 158.65)).toBe(true);
    // Переставленные оси отвергаются парсером, как и до переезда.
    expect(isPlausibleTrackPoint(158.65, 53.04)).toBe(false);
  });
});

describe('расхождение конвертов ЗАФИКСИРОВАНО, а не заметено', () => {
  it('север края: трек принимается, геокодер отвергает', () => {
    // Это и есть несогласие платформы с самой собой. Тест не чинит его —
    // он не даёт ему исчезнуть из виду до решения владельца.
    expect(isPlausibleTrackPoint(65.0, 166.0)).toBe(true);
    expect(withinKamchatka(65.0, 166.0)).toBe(false);
  });

  it('восток: трек и конверт края принимают, геокодер отвергает', () => {
    expect(isPlausibleTrackPoint(55.0, 170.0)).toBe(true);
    expect(withinKamchatka(55.0, 170.0)).toBe(false);
  });

  it('приёмник наблюдений судит самым узким конвертом', () => {
    // /api/safety/reports гейтит наблюдение туриста через withinKamchatka,
    // то есть отвергает точку, с которой принял бы SOS.
    const src = readFileSync('app/api/safety/reports/route.ts', 'utf-8');
    expect(src).toContain('withinKamchatka');
  });

  it('расхождение названо в файле словами, а не только числами', () => {
    const home = readFileSync(HOME, 'utf-8');
    expect(home).toContain('#1961');
    expect(home, 'таблица трёх конвертов пропала из объяснения').toMatch(/KAMCHATKA_BOUNDS/);
    expect(home, 'пропало предупреждение, что числа НЕ сведены').toMatch(/НЕ СВЕДЕНЫ|не сведены/);
  });
});
