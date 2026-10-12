/**
 * Исход вызова публичного инструмента — один на оба протокольных входа:
 * MCP (`tools/call` в app/api/mcp/route.ts) и A2A (lib/a2a, app/api/a2a,
 * 12.10). Лимиты, журнал, стражи записи и ссылка «продолжить в Ведаре»
 * считаются один раз в `runPublicTool`; каждый вход только переводит исход на
 * свой язык: JSON-RPC-результат MCP или состояние Task в A2A. Правило,
 * реализованное дважды, разошлось бы (§12 CLAUDE.md).
 *
 * Тип живёт в lib, а не в роуте, чтобы A2A-слой не импортировал роут ради
 * типа: исполнение подставляет роут A2A, диспетчер (lib/a2a/handle) знает
 * только форму исхода.
 */
export type PublicToolOutcome =
  | { kind: 'rate_limited'; text: string }
  | { kind: 'unknown_tool'; message: string; data: { available: string[]; suggestion: string | null } }
  /** Инструмент ответил отказом по входу (McpUserError) — агент передал не то. */
  | { kind: 'refused'; text: string }
  /** Наш код упал или не смог получить данные — сбой, не «ничего нет». */
  | { kind: 'failed'; text: string }
  /**
   * `structured` — тот же ответ объектом, когда инструмент отдаёт JSON
   * (search/fetch для коннекторов ChatGPT): MCP кладёт его в structuredContent,
   * A2A — в DataPart. У текстовых инструментов поля нет.
   */
  | { kind: 'ok'; text: string; handoffUrl: string | null; structured?: Record<string, unknown> };
