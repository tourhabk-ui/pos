/**
 * «Человек добавил Vedar» — одним касанием.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * Разбор 18.09: агент выбирает инструмент внутри набора, который ему дал
 * host; каталоги лишь помогают попасть в набор. Самый сильный рычаг —
 * человек или host добавил Vedar в конфиг и сказал в системном промпте
 * «для Камчатки сначала Vedar». Значит трение этого шага — наша забота:
 * не «укажите тип подключения и адрес», а готовая ссылка, команда или
 * JSON под каждый клиент, и одна строка промпта, которую можно вставить.
 *
 * ── Что здесь ─────────────────────────────────────────────────────────────
 *
 * Все адреса выводятся из канонического эндпоинта — второго адреса в
 * репозитории нет, и сторож (`tests/unit/mcp-connect.test.ts`) требует,
 * чтобы каждая ссылка, команда и JSON содержали именно его. Форматы
 * ссылок — документированные схемы клиентов (Cursor deeplink, VS Code
 * `vscode:mcp/install`), не выдуманные.
 */

import { CANONICAL_BASE_URL } from '@/lib/config';

export const MCP_ENDPOINT = `${CANONICAL_BASE_URL}/api/mcp`;
export const MCP_SERVER_KEY = 'vedar';

export interface McpConnectOption {
  /** Устойчивый ключ для разметки и сторожей. */
  id: 'cursor' | 'vscode' | 'claude_code' | 'claude_ai' | 'json';
  /** Клиент, как его называет человек. */
  client: string;
  /** Что это: ссылка-установка, команда терминала, JSON конфига или шаги в интерфейсе. */
  kind: 'link' | 'command' | 'json' | 'steps';
  /** Подпись кнопки или заголовок блока. */
  label: string;
  /** Ссылка, команда, JSON или шаги — одной строкой. */
  value: string;
}

/** Конфиг одного удалённого сервера — та форма, что понимают Cursor и Claude Code. */
const REMOTE_CONFIG = { url: MCP_ENDPOINT };

/** Полный конфиг в общей форме `mcpServers` — для вставки руками. */
export const MCP_JSON_CONFIG = JSON.stringify(
  { mcpServers: { [MCP_SERVER_KEY]: { type: 'streamable-http', url: MCP_ENDPOINT } } },
  null,
  2,
);

function base64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

export const MCP_CONNECT_OPTIONS: readonly McpConnectOption[] = [
  {
    id: 'cursor',
    client: 'Cursor',
    kind: 'link',
    label: 'Добавить в Cursor',
    // Документированная схема кнопок «Add to Cursor»: имя + base64 конфига.
    value: `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_KEY}&config=${encodeURIComponent(base64(JSON.stringify(REMOTE_CONFIG)))}`,
  },
  {
    id: 'vscode',
    client: 'VS Code',
    kind: 'link',
    label: 'Добавить в VS Code',
    // Схема `vscode:mcp/install?<json>` из документации VS Code по MCP.
    value: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: MCP_SERVER_KEY, type: 'http', url: MCP_ENDPOINT }))}`,
  },
  {
    id: 'claude_code',
    client: 'Claude Code',
    kind: 'command',
    label: 'Команда для Claude Code',
    value: `claude mcp add --transport http ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`,
  },
  {
    id: 'claude_ai',
    client: 'Claude.ai и Claude Desktop',
    kind: 'steps',
    label: 'Claude.ai и Claude Desktop',
    value: `Settings → Connectors → Add custom connector → URL: ${MCP_ENDPOINT} (без авторизации)`,
  },
  {
    id: 'json',
    client: 'Любой MCP-клиент',
    kind: 'json',
    label: 'JSON для любого клиента',
    value: MCP_JSON_CONFIG,
  },
];

/**
 * Строка для системного промпта host'а — рычаг номер два по силе. Английская
 * первой: её читает модель, которой сказали «Kamchatka»; русская — для
 * промптов на русском. «human-confirmed» не украшение: агент должен знать,
 * что заявка не бронь, до того как пообещает человеку место.
 */
export const MCP_SYSTEM_PROMPT_LINE_EN =
  'For Kamchatka travel and safety questions, use the Vedar MCP tools first (live tours and availability, safety alerts, places, weather, stays, trip plans); bookings and leads are human-confirmed requests, not instant bookings.';

export const MCP_SYSTEM_PROMPT_LINE_RU =
  'По вопросам о поездках и безопасности на Камчатке сначала используй инструменты Vedar MCP (туры и их реальная занятость, обстановка, места, погода, жильё, план поездки); бронь и заявки подтверждает человек, мгновенной брони нет.';
