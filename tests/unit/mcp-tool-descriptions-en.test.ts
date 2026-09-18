/**
 * Сторож: наружу — английская первая фраза с «Kamchatka», внутри — русское
 * описание Кузьмича без изменений.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * Замер 18.09: все 13 описаний в `tools/list` только по-русски, ни в одном
 * нет «Kamchatka» латиницей. Агент выбирает инструмент по name + description;
 * поиск Smithery и оценка Glama ранжируют по словам. Решение владельца:
 * английский слой добавляется только в публичный реестр MCP, схемы Кузьмича
 * не трогаются; слова — по роли инструмента, без эссе.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * У каждого публичного инструмента: английская фраза впереди, «Kamchatka» в
 * ней, слова роли (safety/alerts, live availability, human-confirmed),
 * английский заголовок; русская часть равна описанию из реестра Кузьмича
 * (или константе заявки) символ в символ. Записей в TOOL_ENGLISH ровно
 * столько, сколько инструментов наружу.
 */
import { describe, it, expect } from 'vitest';
import {
  PUBLIC_MCP_TOOLS, TOOL_ENGLISH, TOOL_ANNOTATIONS, EXCLUDED_TOOLS, PARAM_ENGLISH,
  CREATE_LEAD_TOOL, BOOKING_REQUEST_TOOL,
} from '@/lib/mcp/public-tools';
import { TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';

const CYRILLIC = /[А-Яа-яЁё]/;

/** Русское описание, каким его читает Кузьмич (или константа заявки). */
function kuzmichDescription(name: string): string {
  if (name === CREATE_LEAD_TOOL.name) return CREATE_LEAD_TOOL.description;
  if (name === BOOKING_REQUEST_TOOL.name) return BOOKING_REQUEST_TOOL.description;
  const t = Object.values(TOOL_REGISTRY).find((r) => r.definition.function.name === name);
  if (!t) throw new Error(`${name}: нет в реестре Кузьмича`);
  return t.definition.function.description;
}

/** Схема параметров, какой её читает Кузьмич (или константа заявки). */
function kuzmichSchema(name: string): { properties?: Record<string, { description?: string }> } {
  if (name === CREATE_LEAD_TOOL.name) return CREATE_LEAD_TOOL.inputSchema;
  if (name === BOOKING_REQUEST_TOOL.name) return BOOKING_REQUEST_TOOL.inputSchema;
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
];

const ROLE_WORDS: Array<[RegExp, RegExp, string]> = [
  [/^(safety_status|get_guardian_context)$/, /\b(safety|alerts)\b/, 'safety или alerts'],
  [/^(get_tours|get_tour_availability|make_trip_plan|create_booking_request)$/, /\blive availability\b/, 'live availability'],
  [/^(create_lead|create_booking_request)$/, /\bhuman-confirmed\b/, 'human-confirmed'],
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

      it('параметры: английская фраза впереди, русское описание Кузьмича следом; примеры — только заданные', () => {
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
          const ru = original.properties?.[p]?.description ?? '';
          expect(prop.description, `${t.name}.${p}: описание не начинается с английской фразы`).toBe(ru ? `${en[p].lead} ${ru}` : en[p].lead);
          if (en[p].example !== undefined) expect(prop.examples).toEqual([en[p].example]);
          else expect(prop.examples).toBeUndefined();
          // Схема Кузьмича не тронута.
          expect(original.properties?.[p]?.description ?? '', `${t.name}.${p}: схема Кузьмича изменена`).not.toMatch(/^[A-Z]/);
        }
      });

      it('русская часть — описание Кузьмича символ в символ', () => {
        expect(t.description.slice(en.lead.length + 1)).toBe(kuzmichDescription(t.name));
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

describe('Кузьмич не задет', () => {
  it('в реестре Кузьмича описания по-прежнему русские, без английского слоя', () => {
    for (const t of Object.values(TOOL_REGISTRY)) {
      const d = t.definition.function.description;
      expect(d, t.definition.function.name).toMatch(CYRILLIC);
      expect(d.startsWith('Kamchatka'), t.definition.function.name).toBe(false);
    }
  });
});
