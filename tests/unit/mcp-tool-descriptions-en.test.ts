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
  PUBLIC_MCP_TOOLS, TOOL_ENGLISH, TOOL_ANNOTATIONS, EXCLUDED_TOOLS,
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
        // Фраза, не эссе.
        expect(en.lead.length).toBeLessThanOrEqual(160);
        expect(en.lead.endsWith('.')).toBe(true);
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

describe('Кузьмич не задет', () => {
  it('в реестре Кузьмича описания по-прежнему русские, без английского слоя', () => {
    for (const t of Object.values(TOOL_REGISTRY)) {
      const d = t.definition.function.description;
      expect(d, t.definition.function.name).toMatch(CYRILLIC);
      expect(d.startsWith('Kamchatka'), t.definition.function.name).toBe(false);
    }
  });
});
