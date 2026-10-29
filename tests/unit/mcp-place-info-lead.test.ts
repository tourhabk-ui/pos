/**
 * Сторож: лид get_place_info в MCP называет то, что ответ отдаёт, и не
 * отрицает этого (ловушка mcp-instructions, 29.10).
 *
 * Было: «Kamchatka place facts only: what it is, type, coordinates. Does not
 * return hazards, alerts or nearby places». А ответ с 26.09 начинается
 * строками фактов из location_safety_profile — опасности, до медпомощи,
 * спутниковая связь, регистрация группы в МЧС, — а с #2835 несёт туры к месту
 * с компанией у каждого. Живой MCP 29.10, «Курильское озеро»: «Опасности:
 * медведи» и 4 тура от 3 компаний под описанием «Does not return hazards».
 * Прежний сторож требовал ровно эту фразу — держал ложь (правило 13.10).
 *
 * Теперь сторож судит поведение: ответ берётся тем же исполнителем, что зовёт
 * роут MCP (executeKuzmichTool с surface 'mcp'), на записанном профиле места;
 * каждый род факта в ответе назван в лиде и ни один не отрицается; живых
 * тревог исполнитель не читает — поэтому лид отсылает за ними к
 * get_guardian_context. Новый род строки фактов без слова в лиде — красный.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { pool } from '@/lib/db-pool';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { placeFactLines, type PlaceRow } from '@/lib/kuzmich/place-info-tool';
import { PUBLIC_MCP_TOOLS, TOOL_ENGLISH } from '@/lib/mcp/public-tools';
import { HAZARDS } from '@/lib/safety/hazard-labels';

const LEAD = TOOL_ENGLISH.get_place_info.lead;

/**
 * Род строки фактов (текст до двоеточия) → слово, которым лид его называет.
 * Строка нового рода без записи здесь — красный: назови её в лиде.
 */
const FACT_KINDS: Record<string, RegExp> = {
  'Тип': /\btype\b/,
  'Координаты': /\bcoordinates\b/,
  'Высота': /\baltitude\b/,
  'Опасности': /\bhazards\b/,
  'До медпомощи': /\bmedical help\b/,
  'Спутниковая связь': /\bsatellite\b/,
  'Регистрация группы в МЧС': /\bMChS registration\b/,
};
/** Туры к месту с компанией у каждого (#2835). */
const TOURS_WORD = /\btours by company\b/;

/** Отрицание факта в лиде — запрет: «Does not return hazards» и ему подобные. */
function denies(lead: string, word: RegExp): boolean {
  return new RegExp(String.raw`\b(?:no|not|without|never|excluding)\b[^.—;:]*${word.source}`, 'i').test(lead);
}

/** Тревожные таблицы: их читает get_guardian_context, а не карточка места. */
const LIVE_ALERT_TABLES = /\b(external_alerts|safety_alerts|volcano_status|volcano_bulletin_kfegs|location_real_time_status)\b/;

const [h1, h2] = Object.keys(HAZARDS);

/** Место со всеми записанными полями профиля — профиль заведён руками. */
const LAKE: PlaceRow = {
  id: 'p-kuril', name: 'Курильское озеро', category: 'lake', district: 'Южная Камчатка', is_visible: true,
  location_type: 'lake', lat: '51.45', lng: '157.1', altitude_m: 104,
  hazard_types: [h1, h2], profile_source: 'manual', nearest_medical_km: '120',
  sat_communicator_required: true, registration_required: true,
  description: 'Нерестовое озеро в кальдере.',
};

const TOUR_ROW = (id: string, partner: string, name: string) => ({
  id, slug: `tur-${id}`, title: `Тур ${id}`, base_price: '15000', price_unit: 'per_person', duration_type: 'single_day',
  multi_day_count: null, duration_hours: '10', season_start: null, season_end: null, partner_id: partner, partner_name: name,
  partner_slug: null, partner_public: true, partner_verified: null, nearest_free_date: null, keeps_schedule: false, link_kind: 'main_place',
});

let sqlSeen: string[] = [];

function db(place: PlaceRow): void {
  sqlSeen = [];
  vi.mocked(pool.query).mockImplementation((async (sql: string) => {
    sqlSeen.push(sql);
    if (/FROM route_waypoints/.test(sql)) return { rows: [TOUR_ROW('81', 'a', 'Компания А'), TOUR_ROW('79', 'b', 'Компания Б')] };
    if (/FROM places p/.test(sql)) return { rows: [place] };
    return { rows: [] };
  }) as unknown as typeof pool.query);
}

beforeEach(() => db(LAKE));

describe('get_place_info: ответ MCP — записанные факты и туры к месту', () => {
  it('исполнитель MCP отдаёт опасности, медпомощь, связь, МЧС места и туры с компаниями', async () => {
    const out = await executeKuzmichTool('get_place_info', { name: 'Курильское озеро' }, { surface: 'mcp' });
    expect(out).toContain(`Опасности: ${HAZARDS[h1].label.toLocaleLowerCase('ru-RU')}`);
    expect(out).toContain('До медпомощи: 120 км');
    expect(out).toContain('Спутниковая связь: нужна');
    expect(out).toContain('Регистрация группы в МЧС: требуется');
    expect(out).toContain('2 предложения от 2 компаний');
    expect(out).toContain('Компания А');
    expect(out).toContain('Компания Б');
  });

  it('опасность из шаблона типа фактом не называется — лид говорит «on record»', async () => {
    db({ ...LAKE, profile_source: 'type_template' });
    const out = await executeKuzmichTool('get_place_info', { name: 'Курильское озеро' }, { surface: 'mcp' });
    expect(out).not.toContain('Опасности:');
    expect(LEAD).toMatch(/\bon record\b/);
  });

  it('живых тревог исполнитель не читает — лид отсылает за ними к get_guardian_context', async () => {
    await executeKuzmichTool('get_place_info', { name: 'Курильское озеро' }, { surface: 'mcp' });
    expect(sqlSeen.length).toBeGreaterThan(0);
    for (const sql of sqlSeen) expect(sql).not.toMatch(LIVE_ALERT_TABLES);
    expect(LEAD).toMatch(/\bno live alerts\b[^.]*\bget_guardian_context\b/i);
  });
});

describe('get_place_info: лид называет каждый род факта ответа и не отрицает ни одного', () => {
  it('описание инструмента в tools/list начинается этим лидом', () => {
    const tool = PUBLIC_MCP_TOOLS.find((t) => t.name === 'get_place_info');
    expect(tool?.description.startsWith(`${LEAD} `)).toBe(true);
  });

  it('у каждой строки фактов есть слово в лиде', () => {
    const kinds = placeFactLines(LAKE).map((line) => line.slice(0, line.indexOf(':')));
    for (const kind of kinds) {
      const word = FACT_KINDS[kind];
      expect(word, `строка «${kind}:» есть в ответе, а в FACT_KINDS её нет — назови её в лиде`).toBeDefined();
      expect(LEAD, `лид не называет «${kind}»`).toMatch(word);
      expect(denies(LEAD, word), `лид отрицает «${kind}»`).toBe(false);
    }
    // Все поля профиля записаны — значит, выведены все роды строк; запись
    // таблицы, которой ответ больше не производит, тоже не остаётся.
    expect(kinds.sort()).toEqual(Object.keys(FACT_KINDS).sort());
  });

  it('туры к месту названы и не отрицаются', () => {
    expect(LEAD).toMatch(TOURS_WORD);
    expect(denies(LEAD, /\btours\b/)).toBe(false);
  });

  it('запрет на отрицание срабатывает: прежний лид краснел бы', () => {
    const OLD = 'Kamchatka place facts only: what it is, type, coordinates. Does not return hazards, alerts or nearby places — for safety use get_guardian_context.';
    expect(denies(OLD, FACT_KINDS['Опасности'])).toBe(true);
    expect(OLD).not.toMatch(FACT_KINDS['Регистрация группы в МЧС']);
  });
});
