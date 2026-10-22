/**
 * Типы расшифровки MCP по суткам — без импортов, чтобы их брал и клиентский
 * экран (app/hub/admin/mcp/_McpDayBreakdown): серверный модуль
 * lib/mcp/day-breakdown тянет базу и журнал, а сборка для браузера —
 * tests/unit/client-no-node-builtins — их нести не должна.
 */
export const BREAKDOWN_ORIGINS = ['external', 'self', 'probe', 'own'] as const;
export type BreakdownOrigin = (typeof BREAKDOWN_ORIGINS)[number];
export const BREAKDOWN_OUTCOMES = ['all', 'failure', 'refusal'] as const;
export type BreakdownOutcome = (typeof BREAKDOWN_OUTCOMES)[number];

export interface BreakdownQuery {
  /** external — внешние; self — метка владельца; probe — проверки; own — свои и проверки вместе. */
  origin: BreakdownOrigin;
  outcome: BreakdownOutcome;
  /** Сколько камчатских суток подряд (1–30). */
  days: number;
  /** Сколько последних суток пропустить: 0 — с сегодняшних, 1 — со вчерашних. */
  skip: number;
}

export interface TopicRow { tool: string; key: string | null; value: string | null; n: number }
export interface ClientDay {
  client: string;
  /** Откуда имя: представился сам, по заголовку или неизвестно. */
  kind: string;
  origin: 'external' | 'self' | 'probe';
  region: string | null;
  calls: number;
  /** Разных вызывающих этой программой за сутки (суточный хэш). */
  callers: number;
  failures: number;
  refusals: number;
  tools: Array<{ tool: string; calls: number }>;
  topics: TopicRow[];
  /** Сколько тем не показано сверх TOPICS_PER_CLIENT: хвост называется числом, а не пропадает. */
  topics_more: number;
}
export interface BreakdownDay { day: string; calls: number; callers: number; clients: ClientDay[] }
export interface Breakdown { from: string; to: string; days: BreakdownDay[] }
