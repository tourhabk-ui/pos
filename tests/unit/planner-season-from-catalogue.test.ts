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
import { buildTripSeason, inSeasonIn } from '@/lib/planner/trip-season';

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
    // Правило — вызовом (с 14.11 оно в lib/planner/trip-season, по месяцу дня).
    const empty = buildTripSeason([7, 10], new Map([[7, new Set<string>()], [10, new Set<string>()]]), new Set());
    expect(inSeasonIn(empty, 'fishing', 7)).toBe(true);
    expect(inSeasonIn(empty, 'fishing', 10)).toBe(false);
    const autumn = buildTripSeason([10], new Map([[10, new Set(['fishing'])]]), new Set());
    expect(inSeasonIn(autumn, 'fishing', 10)).toBe(true);
    // Каталог не прочитался — действует один пол, а не «всё открыто».
    const unread = buildTripSeason([7, 10], new Map([[7, null], [10, null]]), null);
    expect(inSeasonIn(unread, 'fishing', 7)).toBe(true);
    expect(inSeasonIn(unread, 'fishing', 10)).toBe(false);
  });

  it('сезон спрашивается ОДИН раз и кормит все три места, где он решает', () => {
    // Разойдясь, они дали бы план с рыбалкой и отказ про несезонную рыбалку
    // в одном ответе.
    // С 14.11 — по каждому месяцу поездки: записи операторов спрашиваются
    // одним местом за каждый месяц и собираются в один сезон поездки.
    expect(ENGINE).toMatch(/for \(const m of months\) scheduled\.set\(m, await fetchActivitiesBookableInMonth\(m, cache\)\)/);
    expect(ENGINE.match(/fetchActivitiesBookableInMonth\(/g)).toHaveLength(1);
    // Туры без календаря (08.10) подмешиваются в тот же единственный сезон,
    // а не становятся вторым свидетелем, которого одно из трёх мест не спросит.
    // С 21.11 — по месяцам: у каждого месяца свои туры без календаря (по сезону тура).
    expect(ENGINE).toMatch(/const season = buildTripSeason\(months, scheduled, onRequestByMonth\)/);
    // С 08.10 зоны и дни считаются по профилю без занятий не по возрасту детей
    // (planProfile) — сезон передаётся тот же.
    expect(ENGINE).toMatch(/scoreZones\(planProfile, cache, season\)/);
    // Проверяется, что каталог ДОХОДИТ до сбора предупреждений, а не что он
    // стоит последним аргументом: 27.09 к вызову добавились зоны готового плана
    // (предупреждения о разрешениях считались по зонам-кандидатам и требовали
    // погранзону ФСБ для поездки, которой нет). Правило то же, порядок другой.
    expect(ENGINE).toMatch(/collectWarnings\([^)]*season/);
    expect(ENGINE).toMatch(/generateDayPlans\(planProfile, zones, tripDays, cache, season/);
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
    // По месяцам поездки: не прочитался хоть один — сказано.
    expect(ENGINE).toMatch(/if \(months\.some\(\(m\) => scheduled\.get\(m\) === null\)\)/);
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
    expect(tool).toContain('buildRefusal(month, interests, SITE, rec.catalogueOpen, rec.childBlocked ?? [])');
  });
});
