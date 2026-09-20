/**
 * Сторож: сезон судит не только зашитая таблица, но и запись оператора.
 *
 * ── Замер с прода 20.09 (MCP `get_tours`) ────────────────────────────────
 *
 * Живых туров восемь. Семь — `fishing`, восьмой — «Сплав по реке Быстрая» с
 * типом `rafting`. Ни одного тура с `volcano`, `bears`, `thermal`,
 * `boat_trip`, `helicopter`, `trekking`.
 *
 * Отсюда два дефекта, каждый стоил продажи:
 *
 * 1. `rafting` нет в `ACTIVITY_CONSTRAINTS`, а отбор сравнивает тип точным
 *    равенством — значит живой тур за 13 000 ₽ невидим планировщику
 *    принципиально, в любой месяц и при любых интересах.
 *
 * 2. `fishing.months` = [6,7,8,9], расчёт идёт на октябрь, и планировщик
 *    отказывал: «в октябре рыбалка не сезон». В каталоге при этом лежит
 *    «Осенняя рыбалка (октябрь-ноябрь)» с ближайшей датой 1 октября. Мы
 *    отказывались продавать единственное, что у нас есть, — семь туров из
 *    восьми.
 *
 * ── Что сторож держит и чего НЕ разрешает ────────────────────────────────
 *
 * Таблица остаётся ПОЛОМ: она несёт не только коммерцию, но и безопасность
 * («снег на тропах тает к середине июня»). Каталог окно только РАСШИРЯЕТ, и
 * расхождение между ними говорится словами, а не разрешается молча в чью-то
 * пользу (§4.0). Свидетелем взят слот — действие оператора, а не его
 * описание: объявленный `season_start` мог остаться с прошлого года.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY_ALIASES, ACTIVITY_CONSTRAINTS, rawTypesFor, normalizeActivity } from '@/lib/planner/constants';
import { inSeasonInterests, buildRefusal } from '@/lib/kuzmich/trip-plan-tool';

const ROOT = process.cwd();
const ENGINE = readFileSync(join(ROOT, 'lib/planner/engine.ts'), 'utf8');
const DATA = readFileSync(join(ROOT, 'lib/planner/data.ts'), 'utf8');

describe('слово оператора переводится в ключ движка', () => {
  it('rafting числится сплавом, а не пропадает', () => {
    expect(normalizeActivity('rafting')).toBe('river');
  });

  it('у каждого перевода есть ключ-получатель', () => {
    // Алиас, ведущий в несуществующую активность, — тот же провод в никуда:
    // тур перестал пропадать по одной причине и начал по другой.
    for (const [raw, key] of Object.entries(ACTIVITY_ALIASES)) {
      expect(ACTIVITY_CONSTRAINTS[key], `${raw} → ${key}: такой активности нет`).toBeTruthy();
    }
  });

  it('отбор туров ищет по всем словам активности, а не по одному', () => {
    expect(rawTypesFor('river')).toContain('river');
    expect(rawTypesFor('river')).toContain('rafting');
    // Ключ всегда первым: тур, названный ровно так, ничем не хуже.
    expect(rawTypesFor('volcano')).toEqual(['volcano']);
  });

  it('запрос туров сравнивает со списком, а не точным равенством', () => {
    // `ot.activity_type = $2` не нашёл бы rafting никогда.
    expect(DATA).toContain('ot.activity_type = ANY($2)');
    expect(DATA).toContain('rawTypesFor(activityType)');
  });
});

describe('каталог расширяет сезонное окно', () => {
  it('свидетель — слот в продаже, а не объявленный сезон', () => {
    // Слот это ДЕЙСТВИЕ оператора; `season_start` — описание, и оно могло
    // остаться с прошлого года.
    const fn = DATA.slice(DATA.indexOf('fetchActivitiesBookableInMonth'));
    expect(fn).toContain('JOIN tour_availability');
    expect(fn).toContain('EXTRACT(MONTH FROM ta.date) = $1');
    expect(fn).toContain('ta.date >= CURRENT_DATE');
    expect(fn).toContain('available_slots > COALESCE(ta.booked_slots, 0)');
    // Слово оператора переводится тут же — сравнивать будут с ключами.
    expect(fn).toContain('normalizeActivity');
  });

  it('таблица остаётся полом: каталог только добавляет', () => {
    const fn = ENGINE.slice(ENGINE.indexOf('function inSeason('), ENGINE.indexOf('function openedByCatalogueOnly'));
    expect(fn).toContain('if (c.months.includes(month)) return true;');
    expect(fn).toMatch(/catalogueOpen\?\.has\(interest\) \?\? false/);
  });

  it('сезон спрашивается ОДИН раз и кормит все три места, где он решает', () => {
    // Разойдясь, они дали бы план с рыбалкой и отказ про несезонную рыбалку
    // в одном ответе.
    expect(ENGINE).toMatch(/const catalogueOpen = await fetchActivitiesBookableInMonth\(getMonth\(profile\), cache\)/);
    expect(ENGINE).toMatch(/scoreZones\(profile, cache, catalogueOpen\)/);
    expect(ENGINE).toMatch(/collectWarnings\([^)]*catalogueOpen\)/);
    expect(ENGINE).toMatch(/generateDayPlans\(profile, zones, tripDays, cache, catalogueOpen\)/);
    // Ни одна из трёх проверок не судит по голой таблице.
    expect(ENGINE).not.toMatch(/if \(!c\.months\.includes\(month\)\) continue;/);
  });
});

describe('расхождение называется, а не разрешается молча', () => {
  it('открытое только каталогом даёт предупреждение', () => {
    expect(ENGINE).toContain('openedByCatalogueOnly');
    const at = ENGINE.indexOf('по нашему сезонному ориентиру это уже не сезон');
    expect(at, 'нет слов о расхождении').toBeGreaterThan(0);
    const block = ENGINE.slice(at - 300, at + 400);
    // Не «инфо»: Кузьмич показывает предупреждения severity !== 'info'.
    expect(block).toContain("severity: 'important'");
    expect(block).toContain('оператор открыл запись');
  });

  it('неудавшийся запрос к каталогу тоже назван', () => {
    // «Не знаем» не равно «в каталоге ничего нет» (§4.0).
    expect(ENGINE).toMatch(/if \(catalogueOpen === null\)/);
    expect(ENGINE).toContain('Не удалось свериться с записью операторов');
  });
});

describe('отказ Кузьмича судит тем же сезоном, что и план', () => {
  it('без каталога поведение прежнее', () => {
    expect(inSeasonInterests(10)).not.toContain('fishing');
  });

  it('каталог открыл рыбалку в октябре — отказ это видит', () => {
    expect(inSeasonInterests(10, ['fishing'])).toContain('fishing');
    const text = buildRefusal(10, ['fishing'], 'https://vedarai.ru', ['fishing']);
    // Спрошенное открыто — значит «не сезон» про него говорить нельзя.
    expect(text).not.toContain('не сезон: рыбалка');
    expect(text).toContain('рыбалка');
  });

  it('движок отдаёт открытое каталогом наружу', () => {
    // Иначе отказ и план остались бы двумя голосами об одном (§10.09).
    expect(ENGINE).toMatch(/catalogueOpen: string\[\] \| null;/);
    expect(ENGINE).toMatch(/catalogueOpen: catalogueOpen \? \[\.\.\.catalogueOpen\] : null/);
    const tool = readFileSync(join(ROOT, 'lib/kuzmich/trip-plan-tool.ts'), 'utf8');
    expect(tool).toContain('buildRefusal(month, interests, SITE, rec.catalogueOpen)');
  });
});
