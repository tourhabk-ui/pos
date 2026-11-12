/**
 * Туры для посадочных страниц (lib/seo/query-landings) — из базы на запросе.
 *
 * Витрина — тот же предикат, что каталог, /zh и sitemap (publicTourSql).
 * Порядок — правило 1в (слово владельца 29.10, lib/tours/offer-order), то же,
 * что у /zh и всех общих витрин: со свободной датой — по ближайшему выезду,
 * остальные — жребий дня; без поднятий (CLAUDE.md §0). Ближайшая открытая
 * дата — то самое одно условие (lib/tours/nearest-free-date), по которому
 * строится порядок; своей копии по CURRENT_DATE здесь больше нет. Отказ базы
 * — null и SQLSTATE в лог: страница говорит «не загрузилось», а не
 * показывает пустой список (§4.0).
 */
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { orderOffersBy } from '@/lib/tours/offer-order';
import { logText } from '@/lib/log/log-text';
import { withZhTitles, type ZhTourRow } from '@/lib/zh/entry';
import type { LandingTopic } from '@/lib/seo/query-landings';

export interface LandingTourRow extends ZhTourRow {
  season_start: string | null;
  season_end: string | null;
  /** Ближайшая дата со свободными местами, 'YYYY-MM-DD'; нет — null (по запросу). */
  next_open_date: string | null;
  activity_type?: string | null;
  location_name?: string | null;
}

const BEAR_TYPES = new Set(['bears', 'bear_watching']);
// Существительное «медведь» во всех падежах, словом целиком: «Медвежья чаша»
// (маар у озера Толмачёва) — прилагательное, медвежий тур оно не делает.
const BEAR_WORD = /(^|[^а-яё])медвед(ь|я|ю|ем|е|и|ей|ям|ями|ях)(?![а-яё])/i;
// Курильское озеро — место наблюдения медведей; тур туда (ID67, вертолёт) — медвежий.
const BEAR_PLACE = /(^|[^а-яё])курильск(ое|ого|ому|им|ом)\s+озер/i;
// «вулкан» как существительное; «вулканический песок» (ID53) — не вулканический тур.
const VOLCANO_WORD = /(^|[^а-яё])вулкан(а|у|ом|е|ы|ов|ам|ами|ах)?(?![а-яё])/i;
// Главная цель — именованный вулкан (ID61 Горелый, ID62 Авачинский перевал).
const VOLCANO_NAME = /(^|[^а-яё])(авачинск|корякск|горел|мутновск|толбачик|ключевск|ксудач|вилючинск|карымск|шивелуч|безымянн)[а-яё]*/i;

// Авачинский вулкан и перевал — но не Авачинская бухта и губа (там морские прогулки).
const AVACHA_WORD = /(^|[^а-яё])авачинск[а-яё]*(?![а-яё])(?!\s+(бух|губ))/i;
// Долина гейзеров Кроноцкого заповедника; «Малая Долина гейзеров» (Дачные
// источники, ID57) — другое место у Мутновского, тур туда сюда не попадает.
const GEYSERS_WORD = /(^|[^а-яё])долин[а-яё]*\s+гейзер/i;
const GEYSERS_SMALL = /(^|[^а-яё])мал(ая|ой|ую|ою)\s+долин[а-яё]*\s+гейзер/i;
const FISHING_WORD = /(^|[^а-яё])рыбал(ка|ки|ке|ку|кой|ок|ках)(?![а-яё])/i;
// Мутновский вулкан по имени: «Мутновская ГеоЭС» и «Мутновское плато» — тоже
// его окрестности, но тур туда не тур к вулкану; слово — прилагательное мужского рода.
const MUTNOVSKY_WORD = /(^|[^а-яё])мутновск(ий|ого|ому|им|ом)(?![а-яё])/i;
// Халактырский пляж; Халактырское озеро — другое место.
const KHALAKTYR_WORD = /(^|[^а-яё])халактырск(ий|ого|ому|им|ом)\s+пляж/i;

// Толбачик по имени: Плоский и Острый Толбачик, «Толбачик: по следам извержений».
const TOLBACHIK_WORD = /(^|[^а-яё])толбачик[а-яё]*(?![а-яё])/i;
// Вертолёт словом целиком во всех падежах; «облёт» без вертолёта не берём —
// облетают и на самолёте.
const HELICOPTER_WORD = /(^|[^а-яё])вертол[её]т(а|у|ом|е|ы|ов|ам|ами|ах)?(?![а-яё])/i;
// Снегоход и «снегоходная экскурсия»; в описании и программе слово встречается
// у зимней рыбалки (дорога на базу) — туда не смотрим.
const SNOWMOBILE_WORD = /(^|[^а-яё])снегоход[а-яё]*(?![а-яё])/i;

export interface TopicInput { activity_type: string | null; title: string; location_name: string | null }

/**
 * Попадает ли тур в тему. Сначала тип активности; запасной путь — слово целиком
 * в названии и месте назначения (не в описании: там «видели медведя» и
 * «вулканический песок» встречаются у чего угодно).
 */
export function matchesTopicText(text: string, topic: Exclude<LandingTopic, 'all'>): boolean {
  switch (topic) {
    case 'bears': return BEAR_WORD.test(text) || BEAR_PLACE.test(text);
    case 'volcano': return VOLCANO_WORD.test(text) || VOLCANO_NAME.test(text);
    case 'avacha': return AVACHA_WORD.test(text);
    case 'geysers': return GEYSERS_WORD.test(text) && !GEYSERS_SMALL.test(text);
    case 'fishing': return FISHING_WORD.test(text);
    // Курильское озеро — то же слово, что делает тур медвежьим (BEAR_PLACE).
    case 'kurile': return BEAR_PLACE.test(text);
    case 'mutnovsky': return MUTNOVSKY_WORD.test(text);
    case 'khalaktyr': return KHALAKTYR_WORD.test(text);
    case 'tolbachik': return TOLBACHIK_WORD.test(text);
    case 'helicopter': return HELICOPTER_WORD.test(text);
    case 'snowmobile': return SNOWMOBILE_WORD.test(text);
    // Трансфер — машина под заказ, а не тур: туров и статей у этой темы нет.
    case 'transfer': return false;
    default: throw new Error(`matchesTopicText: неизвестная тема ${String(topic)}`);
  }
}

export function matchesTopic(t: TopicInput, topic: LandingTopic): boolean {
  const text = `${t.title} ${t.location_name ?? ''}`;
  switch (topic) {
    case 'all': return true;
    case 'bears': return BEAR_TYPES.has(t.activity_type ?? '') || matchesTopicText(text, 'bears');
    case 'volcano': return t.activity_type === 'volcano' || matchesTopicText(text, 'volcano');
    case 'avacha': return matchesTopicText(text, 'avacha');
    case 'geysers': return matchesTopicText(text, 'geysers');
    case 'fishing': return t.activity_type === 'fishing' || matchesTopicText(text, 'fishing');
    case 'kurile': case 'mutnovsky': case 'khalaktyr': case 'tolbachik': return matchesTopicText(text, topic);
    case 'helicopter': return t.activity_type === 'helicopter' || matchesTopicText(text, 'helicopter');
    case 'snowmobile': return t.activity_type === 'snowmobile' || matchesTopicText(text, 'snowmobile');
    case 'transfer': return false;
    default: throw new Error(`matchesTopic: неизвестная тема ${String(topic)}`);
  }
}

export function landingToursSql(): string {
  return `SELECT ot.id::text AS id, ot.slug, ot.title, ot.base_price::text AS base_price, ot.price_unit,
              ot.duration_hours::text AS duration_hours,
              ot.season_start::text AS season_start, ot.activity_type, ot.location_name, ot.season_end::text AS season_end,
              p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public,
              ${nearestFreeDateSql('ot')} AS next_open_date
         FROM operator_tours ot
         JOIN partners p ON ot.operator_id = p.id
        WHERE ${publicTourSql('ot')}`;
}

export async function loadLandingTours(topic: LandingTopic, withZh: boolean): Promise<LandingTourRow[] | null> {
  if (topic === 'transfer') return [];
  try {
    const { rows } = await pool.query<LandingTourRow>(landingToursSql());
    const picked = rows.filter((r) => matchesTopic({ activity_type: r.activity_type ?? null, title: r.title, location_name: r.location_name ?? null }, topic));
    const ordered = orderOffersBy(picked, (r) => ({ id: r.id, nearestFreeDate: r.next_open_date ?? null }));
    return withZh ? await withZhTitles(ordered) : ordered;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[query-landing] туры не прочитаны:', topic, typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}
