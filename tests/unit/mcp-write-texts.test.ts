/**
 * Что пишет агент через Ведар — одно и то же в каждом тексте для агентов
 * (проверка MCP и A2A 07.11).
 *
 * Найдено:
 * - в llms.txt стояло «те же пять» заявок, а их шесть: create_trip_request
 *   добавили позже, текст не обновили, и сторож держал устаревшую цифру;
 * - описание MCP и карточка A2A говорили «Записей шесть, и все — заявки», хотя
 *   make_trip_plan и edit_trip_plan сохраняют черновик плана (в разметке
 *   инструментов это честно: «не только чтение»).
 *
 * Сторож сверяет тексты с реестром, а не с числом в памяти: заявки — это
 * WRITE_TOOL_NAMES, черновики — инструменты с пометкой «не только чтение»,
 * которых нет среди заявок.
 *
 * Описание MCP — начало инструкции сервера, а у неё потолок 2048 знаков
 * (mcp-server-instructions). Фраза о черновике туда не влезает, поэтому
 * описание говорит «Заявок шесть» — правду, не «Записей шесть, и все
 * заявки»; о черновике говорят разметка инструментов (readOnlyHint: false)
 * и карточка A2A.
 */
import { describe, it, expect } from 'vitest';
import { MCP_SERVER_INFO, PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { A2A_DESCRIPTION } from '@/lib/a2a/agent-card';

const COUNT_RU: Record<number, string> = { 4: 'четыре', 5: 'пять', 6: 'шесть', 7: 'семь', 8: 'восемь' };
const COUNT_EN: Record<number, string> = { 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' };

/** Пишут, но не заявки: черновик без человека и без ПД. */
const DRAFT_WRITERS = PUBLIC_MCP_TOOLS
  .filter((t) => t.annotations?.readOnlyHint === false && !WRITE_TOOL_NAMES.has(t.name))
  .map((t) => t.name);

describe('тексты для агентов: заявки и черновики', () => {
  it('черновики плана есть в реестре — их и называют тексты', () => {
    expect(DRAFT_WRITERS.sort()).toEqual(['edit_trip_plan', 'make_trip_plan']);
  });

  it('описание MCP: заявок столько, сколько в реестре, и каждая названа; «записей» не говорит', () => {
    const d = MCP_SERVER_INFO.description;
    expect(d).toContain(`Заявок ${COUNT_RU[WRITE_TOOL_NAMES.size]}`);
    for (const name of WRITE_TOOL_NAMES) expect(d, name).toContain(name);
    // «Записей N» — ложь: пишут ещё и черновики плана.
    expect(d).not.toMatch(/Записей/);
  });

  it('карточка A2A — то же по-английски и по-русски', () => {
    expect(A2A_DESCRIPTION).toContain(`${COUNT_EN[WRITE_TOOL_NAMES.size]} human-confirmed requests`);
    expect(A2A_DESCRIPTION).toContain(`Заявок ${COUNT_RU[WRITE_TOOL_NAMES.size]}`);
    expect(A2A_DESCRIPTION).not.toMatch(/Записей/);
    for (const name of [...WRITE_TOOL_NAMES, ...DRAFT_WRITERS]) {
      // По разу в английской и в русской части.
      expect(A2A_DESCRIPTION.split(name).length - 1, name).toBeGreaterThanOrEqual(2);
    }
    expect(A2A_DESCRIPTION).toMatch(/anonymous plan draft for 7 days/);
    expect(A2A_DESCRIPTION).toMatch(/сохраняют черновик плана: анонимно, на 7 дней/);
  });
});
