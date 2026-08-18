/**
 * Откуда у места координата.
 *
 * Ночь 17–18.08 ушла на то, чтобы ЛИНИЯ называла своё происхождение: снята
 * прибором, построена прямыми, пришла импортом. У ТОЧКИ такого не было вовсе.
 *
 * Геокодер поднимал места без GPS в координаты по НАЗВАНИЮ через Nominatim и
 * писал их в `lat/lng`, ничем не помечая: снятая точка и угаданная лежали в
 * базе неотличимо.
 *
 * Цена вскрылась на уборке битых привязок. Правило объявляло ложью связь
 * «маршрут — точка», если точка дальше двух километров от трека, и в списке на
 * снятие оказались:
 *
 *   Природный парк Налычево → Природный парк Налычево: 32.1 км
 *   Халактырский пляж       → Халактырский пляж:        4.5 км
 *   Озеро Паланское         → Озеро Паланское:          3.4 км
 *
 * Все три — ВЕРНЫЕ привязки. У протяжённого объекта координата это центроид, и
 * расстояние до неё не говорит ничего.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coordSourceLabel, coordIsTrustworthy, isExtendedObject, distanceIsMeaningful,
} from '@/lib/places/coord-source';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const MIGRATION = read('migrations/873_places_coord_source.sql');
const GEOCODER = read('app/api/cron/places-geocode/route.ts');
const RULE = read('lib/routes/broken-links.ts');

describe('координата называет своё происхождение', () => {
  it('у каждого рода есть слова для человека', () => {
    expect(coordSourceLabel('surveyed')).toMatch(/снята/);
    expect(coordSourceLabel('geocoded')).toMatch(/угадана/);
    expect(coordSourceLabel('placeholder')).toMatch(/заглушка/);
    expect(coordSourceLabel('unknown')).toMatch(/не записано/);
  });

  it('утверждение строится только на снятой координате', () => {
    expect(coordIsTrustworthy('surveyed')).toBe(true);
    for (const s of ['geocoded', 'placeholder', 'unknown'] as const) {
      expect(coordIsTrustworthy(s), s).toBe(false);
    }
  });

  it('«не записано» не равно «снята»', () => {
    // Для существующих строк unknown — честный ответ «не знаем». Решать по
    // незнанию то же самое, что решать по догадке.
    expect(coordIsTrustworthy('unknown')).toBe(false);
  });
});

describe('протяжённый объект одной точкой не описывается', () => {
  it('парк, пляж, озеро, вулкан — протяжённые', () => {
    for (const t of ['park', 'beach', 'lake', 'volcano', 'river', 'glacier']) {
      expect(isExtendedObject(t), t).toBe(true);
    }
  });

  it('источник и гейзер — точечные', () => {
    expect(isExtendedObject('hot_spring')).toBe(false);
    expect(isExtendedObject('geyser')).toBe(false);
  });

  it('неизвестный род считается протяжённым — осторожность дешевле', () => {
    // Не зная рода, объявить связь ложью значит удалить верную привязку;
    // пропустить лишнюю — только оставить её человеку на разбор.
    expect(isExtendedObject(null)).toBe(true);
    expect(isExtendedObject('')).toBe(true);
    expect(isExtendedObject('чей-то-новый-род')).toBe(true);
  });
});

describe('расстояние судит только при двух условиях сразу', () => {
  it('снятая координата точечного объекта — судит', () => {
    expect(distanceIsMeaningful('surveyed', 'hot_spring')).toBe(true);
  });

  it('снятая координата ПАРКА — не судит', () => {
    // Парк с идеально снятой координатой остаётся парком: центроид в
    // тридцати километрах от тропы это норма, а не ошибка данных.
    expect(distanceIsMeaningful('surveyed', 'park')).toBe(false);
  });

  it('угаданная координата точечного объекта — не судит', () => {
    expect(distanceIsMeaningful('geocoded', 'hot_spring')).toBe(false);
  });

  it('незаписанное происхождение — не судит', () => {
    expect(distanceIsMeaningful('unknown', 'geyser')).toBe(false);
  });
});

describe('запись происхождения доходит до базы', () => {
  it('миграция заводит колонку и не выдумывает прошлое', () => {
    expect(MIGRATION).toMatch(/coord_source/);
    // Backfill скупой: помечаются только плейсхолдеры, видимые из данных.
    // Объявить существующие координаты снятыми было бы той же выдумкой, ради
    // которой колонка и заводится.
    expect(MIGRATION).toMatch(/'placeholder'/);
    expect(MIGRATION).not.toMatch(/SET coord_source = 'surveyed'/);
  });

  it('геокодер помечает СВОИ координаты как угаданные', () => {
    expect(GEOCODER).toMatch(/coord_source = 'geocoded'/);
  });

  it('уборка спрашивает происхождение перед удалением', () => {
    expect(RULE).toMatch(/distanceIsMeaningful\(w\.coordSource, w\.locationType\)/);
  });
});
