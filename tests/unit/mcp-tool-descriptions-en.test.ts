/**
 * Сторож: наружу — описание по-английски, одним языком; русское описание
 * Кузьмича не тронуто и живёт на странице /mcp.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * Замер 18.09: все 13 описаний в `tools/list` только по-русски, ни в одном
 * нет «Kamchatka» латиницей. Агент выбирает инструмент по name + description;
 * поиск в каталогах (реестр MCP, Glama) ранжирует по словам. Решение владельца:
 * английский слой добавляется только в публичный реестр MCP, схемы Кузьмича
 * не трогаются; слова — по роли инструмента, без эссе.
 *
 * 26.11 (слово владельца «Ужми описания»): описание наружу было английской
 * фразой плюс русским описанием целиком, и каждое поле — тоже дважды;
 * tools/list весил ~113 тыс. знаков. Теперь наружу — английская фраза и
 * английские правила, у полей — только английское описание.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * У каждого публичного инструмента: описание = английская фраза с
 * «Kamchatka» и слова роли (safety/alerts, live availability,
 * human-confirmed) + английские правила, без кириллицы; у каждого поля —
 * английское описание без кириллицы; английский заголовок. Русское описание
 * для страницы /mcp равно описанию из реестра Кузьмича (или константе заявки)
 * символ в символ. Записей в TOOL_ENGLISH ровно столько, сколько
 * инструментов наружу. Весь tools/list — не больше потолка.
 */
import { describe, it, expect } from 'vitest';
import {
  PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_DESCRIPTIONS_RU, TOOL_ENGLISH, TOOL_ANNOTATIONS, EXCLUDED_TOOLS, PARAM_ENGLISH,
  CREATE_LEAD_TOOL, BOOKING_REQUEST_TOOL, REQUEST_CHARTER_TOOL,
  CAR_RENTAL_REQUEST_TOOL, TRIP_REQUEST_TOOL, STAY_REQUEST_TOOL, CHANGE_REQUEST_TOOL,
} from '@/lib/mcp/public-tools';
import { TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';
// Пара коннекторов ChatGPT (ступень 2, 12.10): не из реестра Кузьмича, схемы свои.
import { SEARCH_TOOL, FETCH_TOOL } from '@/lib/mcp/connector-schemas';
import { GET_REQUEST_STATUS_TOOL } from '@/lib/mcp/request-status-schema';

const CYRILLIC = /[А-Яа-яЁё]/;

/** Русское описание, каким его читает Кузьмич (или константа заявки). */
function kuzmichDescription(name: string): string {
  if (name === CREATE_LEAD_TOOL.name) return CREATE_LEAD_TOOL.description;
  if (name === BOOKING_REQUEST_TOOL.name) return BOOKING_REQUEST_TOOL.description;
  if (name === STAY_REQUEST_TOOL.name) return STAY_REQUEST_TOOL.description;
  if (name === REQUEST_CHARTER_TOOL.name) return REQUEST_CHARTER_TOOL.description;
  if (name === CAR_RENTAL_REQUEST_TOOL.name) return CAR_RENTAL_REQUEST_TOOL.description;
  if (name === TRIP_REQUEST_TOOL.name) return TRIP_REQUEST_TOOL.description;
  if (name === SEARCH_TOOL.name) return SEARCH_TOOL.description;
  if (name === FETCH_TOOL.name) return FETCH_TOOL.description;
  if (name === GET_REQUEST_STATUS_TOOL.name) return GET_REQUEST_STATUS_TOOL.description;
  if (name === CHANGE_REQUEST_TOOL.name) return CHANGE_REQUEST_TOOL.description;
  const t = Object.values(TOOL_REGISTRY).find((r) => r.definition.function.name === name);
  if (!t) throw new Error(`${name}: нет в реестре Кузьмича`);
  return t.definition.function.description;
}

/** Схема параметров, какой её читает Кузьмич (или константа заявки). */
function kuzmichSchema(name: string): { properties?: Record<string, { description?: string }> } {
  if (name === CREATE_LEAD_TOOL.name) return CREATE_LEAD_TOOL.inputSchema;
  if (name === BOOKING_REQUEST_TOOL.name) return BOOKING_REQUEST_TOOL.inputSchema;
  if (name === STAY_REQUEST_TOOL.name) return STAY_REQUEST_TOOL.inputSchema;
  if (name === REQUEST_CHARTER_TOOL.name) return REQUEST_CHARTER_TOOL.inputSchema;
  if (name === CAR_RENTAL_REQUEST_TOOL.name) return CAR_RENTAL_REQUEST_TOOL.inputSchema;
  if (name === TRIP_REQUEST_TOOL.name) return TRIP_REQUEST_TOOL.inputSchema;
  if (name === SEARCH_TOOL.name) return SEARCH_TOOL.inputSchema;
  if (name === FETCH_TOOL.name) return FETCH_TOOL.inputSchema;
  if (name === GET_REQUEST_STATUS_TOOL.name) return GET_REQUEST_STATUS_TOOL.inputSchema;
  if (name === CHANGE_REQUEST_TOOL.name) return CHANGE_REQUEST_TOOL.inputSchema;
  const t = Object.values(TOOL_REGISTRY).find((r) => r.definition.function.name === name);
  if (!t) throw new Error(`${name}: нет в реестре Кузьмича`);
  return t.definition.function.parameters as { properties?: Record<string, { description?: string }> };
}

/** Пары, которые оценщик путал: фраза называет соседа по имени. */
const DISAMBIGUATION: Array<[string, string]> = [
  ['get_tours', 'get_tour_details'],
  ['get_tour_details', 'get_tours'],
  ['get_place_info', 'get_guardian_context'],
  ['get_guardian_context', 'get_place_info'],
  ['create_booking_request', 'create_lead'],
  ['create_stay_request', 'create_booking_request'],
];

const ROLE_WORDS: Array<[RegExp, RegExp, string]> = [
  [/^(safety_status|get_guardian_context)$/, /\b(safety|alerts)\b/, 'safety или alerts'],
  [/^(get_tours|get_tour_availability|make_trip_plan|create_booking_request)$/, /\blive availability\b/, 'live availability'],
  [/^(create_lead|create_booking_request|request_charter|create_stay_request)$/, /\bhuman-confirmed\b/, 'human-confirmed'],
];

describe('английский слой наружу — у каждого инструмента', () => {
  it('записей ровно столько, сколько инструментов наружу, и ни одной лишней', () => {
    const live = PUBLIC_MCP_TOOLS.map((t) => t.name).sort();
    expect(Object.keys(TOOL_ENGLISH).sort()).toEqual(live);
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual(live);
    for (const name of EXCLUDED_TOOLS) expect(TOOL_ENGLISH[name]).toBeUndefined();
  });

  for (const t of PUBLIC_MCP_TOOLS) {
    describe(t.name, () => {
      const en = TOOL_ENGLISH[t.name];

      it('описание начинается английской фразой с «Kamchatka», без кириллицы в ней', () => {
        expect(t.description.startsWith(`${en.lead} `)).toBe(true);
        expect(en.lead).toMatch(/\bKamchatka\b/);
        expect(en.lead).not.toMatch(CYRILLIC);
        // Фраза, не эссе (200 — с местом на «когда брать соседний инструмент»).
        expect(en.lead.length).toBeLessThanOrEqual(200);
        expect(en.lead.endsWith('.')).toBe(true);
      });

      it('описание — английская фраза и английские правила, без кириллицы', () => {
        expect(t.description).toBe(en.rules ? `${en.lead} ${en.rules}` : en.lead);
        expect(t.description).not.toMatch(CYRILLIC);
      });

      it('параметры: только английское описание; примеры — только заданные', () => {
        /**
         * Glama TDQS 18.09: Completeness 4/5 — параметры были только по-русски.
         * Слой накладывается на КОПИЮ схемы; исходная схема Кузьмича не меняется.
         */
        const schema = t.inputSchema as { properties?: Record<string, { description?: string; examples?: unknown[] }> };
        const original = kuzmichSchema(t.name);
        const params = Object.keys(schema.properties ?? {});
        const en = PARAM_ENGLISH[t.name];
        expect(en, `${t.name}: нет записи в PARAM_ENGLISH`).toBeDefined();
        expect(Object.keys(en).sort(), `${t.name}: параметры в PARAM_ENGLISH не совпадают со схемой`).toEqual(params.sort());
        for (const p of params) {
          const prop = schema.properties![p];
          expect(en[p].lead, `${t.name}.${p}: кириллица в английской фразе`).not.toMatch(CYRILLIC);
          expect(en[p].lead.endsWith('.'), `${t.name}.${p}: фраза без точки`).toBe(true);
          expect(prop.description, `${t.name}.${p}: описание поля не английское`).toBe(en[p].lead);
          if (en[p].example !== undefined) expect(prop.examples).toEqual([en[p].example]);
          else expect(prop.examples).toBeUndefined();
          // Схема Кузьмича не тронута.
          expect(original.properties?.[p]?.description ?? '', `${t.name}.${p}: схема Кузьмича изменена`).not.toMatch(/^[A-Z]/);
        }
      });

      it('русское описание для страницы /mcp — описание Кузьмича символ в символ', () => {
        expect(PUBLIC_MCP_TOOL_DESCRIPTIONS_RU[t.name]).toBe(kuzmichDescription(t.name));
      });

      it('заголовок английский и стоит в аннотациях', () => {
        expect(en.title).not.toMatch(CYRILLIC);
        expect(t.title).toBe(en.title);
        expect(t.annotations?.title).toBe(en.title);
      });

      it('слова роли на месте', () => {
        for (const [names, word, label] of ROLE_WORDS) {
          if (names.test(t.name)) expect(en.lead, `${t.name}: нет слова «${label}»`).toMatch(word);
        }
      });
    });
  }
});

describe('разграничение похожих инструментов — сосед назван по имени', () => {
  for (const [tool, neighbour] of DISAMBIGUATION) {
    it(`${tool} говорит, когда брать ${neighbour}`, () => {
      expect(TOOL_ENGLISH[tool].lead).toContain(neighbour);
    });
  }
});

describe('вес tools/list', () => {
  it('не больше потолка: до 26.11 было ~113 тыс. знаков, после ужатия — ~80 тыс.', () => {
    // Потолок с запасом под новый инструмент; рост сверх — повод ужать, а не поднять.
    expect(JSON.stringify(PUBLIC_MCP_TOOLS).length).toBeLessThanOrEqual(88_000);
  });

  it('в описаниях схем результата нет кириллицы, кроме меток-заглушек в словах адресата', () => {
    const texts: string[] = [];
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          if (k === 'description' && typeof v === 'string') texts.push(v);
          else walk(v);
        }
      }
    };
    for (const t of PUBLIC_MCP_TOOLS) walk(t.outputSchema);
    for (const d of texts) expect(d.replace(/\[(телефон|ссылка|ник|имя)\]/g, ''), d).not.toMatch(CYRILLIC);
  });
});

describe('Кузьмич не задет', () => {
  it('в реестре Кузьмича описания по-прежнему русские, без английского слоя', () => {
    for (const t of Object.values(TOOL_REGISTRY)) {
      const d = t.definition.function.description;
      expect(d, t.definition.function.name).toMatch(CYRILLIC);
      expect(d.startsWith('Kamchatka'), t.definition.function.name).toBe(false);
    }
  });
});
