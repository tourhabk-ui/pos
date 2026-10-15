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
 * `vscode:mcp/install`, Trae `trae-cn://` и `trae://`), не выдуманные.
 */

import { CANONICAL_BASE_URL } from '@/lib/config';

export const MCP_ENDPOINT = `${CANONICAL_BASE_URL}/api/mcp`;
export const MCP_SERVER_KEY = 'vedar';

export interface McpConnectOption {
  /** Устойчивый ключ для разметки и сторожей. */
  id: 'cursor' | 'vscode' | 'trae_cn' | 'trae' | 'claude_code' | 'qwen_code' | 'deepseek_harness' | 'claude_ai' | 'json';
  /** Клиент, как его называет человек. */
  client: string;
  /** Что это: ссылка-установка, команда терминала, JSON конфига или шаги в интерфейсе. */
  kind: 'link' | 'command' | 'json' | 'yaml' | 'steps';
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

/**
 * Ссылка-установка Trae: `<схема>://trae.ai-ide/mcp-import?type=…&name=…&config=…`,
 * config — JSON одного сервера в base64 и затем URL-кодировании (аудит 15.10,
 * CN-zh: китайские клиенты). Форма — по документации Trae, снятой 15.10:
 * docs.trae.cn/ide_mcp-server-install-links.md для `trae-cn://` и
 * docs.trae.ai/ide/mcp-server-install-links для `trae://`; type — `stdio` или
 * `http`. Живым кликом в Trae ссылка не проверялась.
 */
function traeInstallLink(scheme: 'trae-cn' | 'trae'): string {
  return `${scheme}://trae.ai-ide/mcp-import?type=http&name=${MCP_SERVER_KEY}&config=${encodeURIComponent(base64(JSON.stringify(REMOTE_CONFIG)))}`;
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
    // Trae — IDE ByteDance; у китайской сборки (trae.cn) своя схема ссылок.
    // Кнопка нужна тем, кто уже пришёл на /mcp, /zh или в README: находить
    // нас она не помогает, но снимает ручной набор адреса (аудит 15.10, CN-zh).
    id: 'trae_cn',
    client: 'Trae CN (trae.cn)',
    kind: 'link',
    label: 'Добавить в Trae CN',
    value: traeInstallLink('trae-cn'),
  },
  {
    id: 'trae',
    client: 'Trae (trae.ai)',
    kind: 'link',
    label: 'Добавить в Trae',
    value: traeInstallLink('trae'),
  },
  {
    id: 'claude_code',
    client: 'Claude Code',
    kind: 'command',
    label: 'Команда для Claude Code',
    value: `claude mcp add --transport http ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`,
  },
  {
    id: 'qwen_code',
    client: 'Qwen Code',
    kind: 'command',
    label: 'Команда для Qwen Code',
    // Qwen Code наследует формат Gemini CLI: Streamable HTTP — поле httpUrl в
    // ~/.qwen/settings.json, SSE — url (устаревший). Команда даёт ту же запись
    // (документация Qwen Code, разделы users/features/mcp и tools/mcp-server,
    // 12.10). Ответ самого Qwen в чате владельца предлагал "type": "http" с
    // url — это форма Claude Code, не Qwen Code.
    value: `qwen mcp add --transport http ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`,
  },
  {
    id: 'deepseek_harness',
    client: 'DeepSeek Harness (dsh)',
    kind: 'yaml',
    label: 'DeepSeek Harness: плагин dsh-mcp-client',
    // DeepSeek Chat в вебе — не MCP-клиент; MCP у DeepSeek живёт в DeepSeek
    // Harness (developer preview, сборка из исходников), где встроенный плагин
    // @deepseek-ai/dsh-mcp-client монтируется по одному экземпляру на сервер в
    // ~/.dsh/profiles/web/cordis.patch.yml. Инструменты видны модели как
    // mcp__vedar__<tool>. Форма — по документации плагина (разбор 12.10);
    // имён «dsh-mcp-center» и «deepseek-remote-mcp-bridge», которые называл
    // сам DeepSeek в чате владельца, в каталогах не нашлось.
    value: [
      '# ~/.dsh/profiles/web/cordis.patch.yml',
      '- insert:',
      '    - id: mcp-' + MCP_SERVER_KEY,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: ' + MCP_SERVER_KEY,
      '        transport: streamable-http',
      '        url: ' + MCP_ENDPOINT,
    ].join('\n'),
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
  'For Kamchatka travel and safety questions, use the Vedar MCP tools first (live tours and availability, safety alerts, places, weather, stays, trip plans); tour requests and leads are human-confirmed requests passed to the operator; nothing is booked or paid instantly.';

export const MCP_SYSTEM_PROMPT_LINE_RU =
  'По вопросам о поездках и безопасности на Камчатке сначала используй инструменты Vedar MCP (туры и их реальная занятость, обстановка, места, погода, жильё, план поездки); заявки оператору и на подбор подтверждает человек, мгновенного подтверждения и оплаты через платформу нет.';
