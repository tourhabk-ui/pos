/**
 * lib/leads/entry-values.ts — через какой вход пришла заявка, созданная
 * инструментами Ведара (runPublicTool): MCP, A2A или чат Кузьмича.
 *
 * Слово владельца 08.11: «нужно писать, откуда лиды — человек или ИИ и через
 * какой инструмент: ТГ, MAX, MCP, A2A или на сайте Кузьмич». Все пять путей
 * создают заявку одними функциями (app/api/mcp/route.ts), и до 08.11 каждая
 * такая заявка записывалась как `source: 'mcp'` — чат Кузьмича в Telegram
 * был неотличим от внешнего агента, A2A от MCP. Вход пишется в
 * `source_data.entry` при создании заявки (lib/leads/create.ts).
 *
 * Модуль чистый — без Node API: его читают и сервер, и разбор происхождения
 * для экрана (lib/leads/origin.ts).
 */

export const LEAD_ENTRIES = ['mcp', 'a2a', 'kuzmich-web', 'kuzmich-tg', 'kuzmich-max'] as const;

export type LeadEntry = (typeof LEAD_ENTRIES)[number];

export function asLeadEntry(value: unknown): LeadEntry | null {
  return typeof value === 'string' && (LEAD_ENTRIES as readonly string[]).includes(value) ? (value as LeadEntry) : null;
}
