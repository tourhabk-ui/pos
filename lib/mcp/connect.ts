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
  id:
    | 'cursor' | 'vscode' | 'trae_cn' | 'trae' | 'chatbox'
    | 'claude_ai' | 'chatgpt' | 'gemini_app' | 'mistral'
    | 'claude_code' | 'gemini_cli' | 'qwen_code' | 'codebuddy' | 'devin_desktop'
    | 'cline' | 'kilo' | 'zed' | 'goose' | 'cherry_studio' | 'deepseek_harness'
    | 'qwen_chat' | 'kimi' | 'grok' | 'coze' | 'zhipu_glm' | 'gemini_settings' | 'json';
  /** Клиент, как его называет человек. */
  client: string;
  /** Что это: ссылка-установка, команда терминала, JSON конфига или шаги в интерфейсе. */
  kind: 'link' | 'command' | 'json' | 'yaml' | 'steps';
  /** Подпись кнопки или заголовок блока. */
  label: string;
  /** Ссылка, команда, JSON или шаги — одной строкой. */
  value: string;
  /**
   * Что про этот способ НЕ проверено или где ловушка — словами для человека.
   * Нет оговорки — способ сверен с документацией клиента 16.10 (§4.0: чего не
   * знаем, так и говорим, а не прячем за готовой кнопкой).
   */
  note?: string;
}

/** Конфиг одного удалённого сервера — та форма, что понимают Cursor и Claude Code. */
const REMOTE_CONFIG = { url: MCP_ENDPOINT };

/** Полный конфиг в общей форме `mcpServers` — для вставки руками. */
export const MCP_JSON_CONFIG = JSON.stringify(
  { mcpServers: { [MCP_SERVER_KEY]: { type: 'streamable-http', url: MCP_ENDPOINT } } },
  null,
  2,
);

/**
 * Как разные клиенты называют Streamable HTTP — для таблицы на /mcp. Общего
 * написания нет, и чужое в одних клиентах уводит в старый SSE (наш сервер на
 * GET с Accept: text/event-stream отвечает 405), а в других не загружается.
 * Сверено по документации и исходникам клиентов 16.10; `unverified` — где
 * выбор транспорта по `url` документация не описывает.
 */
export interface TransportSpelling {
  clients: string;
  spelling: string;
  unverified?: true;
}

export const MCP_TRANSPORT_SPELLINGS: readonly TransportSpelling[] = [
  { clients: 'Claude Code, VS Code, Continue (JSON), Qoder CN, CodeBuddy, LobeHub', spelling: '"type": "http"' },
  { clients: 'Zoo Code (Roo Code закрыт 15.05.2026), Continue (YAML)', spelling: '"type": "streamable-http"' },
  { clients: 'Cline, Cherry Studio', spelling: '"type": "streamableHttp"' },
  { clients: 'Goose (config.yaml, поле uri), ModelScope', spelling: 'type: streamable_http' },
  { clients: 'Kilo Code 7.x', spelling: 'ключ mcp, "type": "remote"' },
  { clients: 'Qwen Code, Gemini CLI', spelling: 'поле "httpUrl" (поле url там — SSE)' },
  { clients: 'Devin Desktop (бывший Windsurf)', spelling: '"url" и "transport": "http"' },
  { clients: 'Cursor, Zed, JetBrains AI Assistant, Chatbox', spelling: 'только "url"' },
  { clients: 'Warp, JetBrains Junie, Kiro, Trae, LM Studio', spelling: 'только "url"', unverified: true },
];

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
    note: 'Ссылка живым кликом в Trae не проверена. Какой транспорт Trae пробует первым, документация не говорит.',
  },
  {
    id: 'trae',
    client: 'Trae (trae.ai)',
    kind: 'link',
    label: 'Добавить в Trae',
    value: traeInstallLink('trae'),
    note: 'Ссылка живым кликом в Trae не проверена. Какой транспорт Trae пробует первым, документация не говорит.',
  },
  {
    // Chatbox: ссылка установки `chatbox://mcp/install?server=<base64 JSON>`
    // (docs.chatboxai.app/en/guides/mcp, сверено 16.10). Клиент идёт по
    // Streamable HTTP и на SSE откатывается только при 404/405.
    id: 'chatbox',
    client: 'Chatbox',
    kind: 'link',
    label: 'Добавить в Chatbox',
    value: `chatbox://mcp/install?server=${encodeURIComponent(base64(JSON.stringify({ name: MCP_SERVER_KEY, url: MCP_ENDPOINT })))}`,
  },
  {
    id: 'claude_ai',
    client: 'Claude.ai, Claude Desktop и мобильный Claude',
    kind: 'steps',
    label: 'Claude.ai, Claude Desktop и мобильный Claude',
    // Путь по докам Anthropic 16.10 (claude.com/docs/connectors/custom/add-unlisted):
    // Customize, а не Settings, как писали до осени.
    value: `Customize → Connectors → Add custom connector → URL: ${MCP_ENDPOINT} → Authentication: No sign-in (без авторизации)`,
    note: 'Коннектор хранится в аккаунте: добавленный на сайте, он есть в Desktop и в телефоне. На Free — один свой коннектор; в Team и Enterprise его добавляет владелец организации. Через claude_desktop_config.json Claude Desktop к удалённому серверу напрямую не подключается.',
  },
  {
    id: 'chatgpt',
    client: 'ChatGPT',
    kind: 'steps',
    label: 'ChatGPT (веб)',
    // Справка OpenAI 12584461, сверено 17.10: в текущем разделе Plugins сервер
    // добавляется прямо оттуда, Developer Mode включать не нужно; старый путь
    // «Apps → Create» остался как legacy для воркспейсов.
    value: `chatgpt.com → Plugins → + → Add custom MCP server → Connection: ${MCP_ENDPOINT} → Authentication: No authentication → отметить риск → Create as a plugin → в чате @ и выбрать плагин. Если раздела Plugins нет (legacy): Workspace settings → Apps → Create (админ) или Settings → Apps → Create → URL → Scan Tools → Create`,
    note: 'По справке OpenAI (help.openai.com/en/articles/12584461, 17.10): полный MCP с заявками — Business, Enterprise и Edu, создаёт и публикует админ или владелец воркспейса; на Pro — только чтение; только веб, не телефон. Набор инструментов «замораживается» при публикации — после обновления Ведара админ жмёт Refresh. Живьём не проверено; в России ChatGPT официально недоступен.',
  },
  {
    id: 'gemini_app',
    client: 'Gemini (веб и телефон)',
    kind: 'steps',
    label: 'Gemini — Connected Apps',
    value: `gemini.google.com → Settings & help → Connected Apps (или Personal Intelligence → Connected Apps) → Custom apps → Add a custom app → MCP server URL: ${MCP_ENDPOINT} → Next → в чате @ и выбрать Ведар`,
    note: 'По справке Google (support.google.com/gemini/answer/17209137, 17.10): добавлять только на сайте, потом работает и в телефоне; только 18+, США, личный аккаунт Google (не рабочий и не учебный), на английском, с включённой Keep Activity. Живьём не проверено.',
  },
  {
    id: 'mistral',
    client: 'Mistral Le Chat (Vibe)',
    kind: 'steps',
    label: 'Mistral Le Chat (теперь Vibe)',
    value: `chat.mistral.ai → Connectors → + Add Connector → Custom MCP Connector → Connector name: ${MCP_SERVER_KEY} → Server URL: ${MCP_ENDPOINT} → Connect`,
  },
  {
    id: 'claude_code',
    client: 'Claude Code',
    kind: 'command',
    label: 'Команда для Claude Code',
    value: `claude mcp add --transport http ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`,
  },
  {
    // Gemini CLI: `-s user` — для всех проектов (по умолчанию scope project).
    // В settings.json Streamable HTTP — поле httpUrl; `url` без `type: http`
    // старые версии читают как SSE (сверено по исходникам main 16.10).
    id: 'gemini_cli',
    client: 'Gemini CLI',
    kind: 'command',
    label: 'Команда для Gemini CLI',
    value: `gemini mcp add --transport http -s user ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`,
    note: 'Вручную в ~/.gemini/settings.json — поле httpUrl, не url: url без "type": "http" старые версии читают как SSE.',
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
    note: 'Вручную в ~/.qwen/settings.json — поле httpUrl. Поле url в Qwen Code означает SSE, а SSE у Ведара нет.',
  },
  {
    // Tencent CodeBuddy Code (codebuddy.cn/docs/cli/mcp, 16.10).
    id: 'codebuddy',
    client: 'Tencent CodeBuddy',
    kind: 'command',
    label: 'Команда для CodeBuddy Code',
    value: `codebuddy mcp add --scope user --transport http ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`,
    note: 'В IDE и плагине CodeBuddy — тот же сервер JSON-записью с "type": "http"; это значение взято из документации их CLI.',
  },
  {
    // Windsurf переименован в Devin Desktop 02.06.2026; путь к файлу настроек
    // за год менялся трижды, поэтому — команда, она сама выбирает файл.
    id: 'devin_desktop',
    client: 'Devin Desktop (бывший Windsurf)',
    kind: 'command',
    label: 'Команда для Devin Desktop (бывший Windsurf)',
    value: `devin mcp add -s user ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`,
    note: 'Живьём не проверено. Устаревший агент Cascade, если включён, ждёт в mcp_config.json поле serverUrl.',
  },
  {
    // Cline: без type запись уходит в legacy SSE (docs.cline.bot, 16.10).
    id: 'cline',
    client: 'Cline',
    kind: 'json',
    label: 'Cline: cline_mcp_settings.json',
    value: JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { type: 'streamableHttp', url: MCP_ENDPOINT, disabled: false } } }, null, 2),
    note: 'Или в панели Cline: MCP Servers → Remote Servers → Transport Type: Streamable HTTP. Без поля type Cline берёт старый SSE и получает отказ.',
  },
  {
    // Kilo Code 7.x (kilo.ai/docs/automate/mcp, 16.10): ключ mcp, type remote.
    id: 'kilo',
    client: 'Kilo Code',
    kind: 'json',
    label: 'Kilo Code 7.x: ~/.config/kilo/kilo.jsonc',
    value: JSON.stringify({ mcp: { [MCP_SERVER_KEY]: { type: 'remote', url: MCP_ENDPOINT, enabled: true } } }, null, 2),
    note: 'Формат сменился в апреле 2026: старые инструкции с mcpServers и .kilocode/mcp.json к версии 7 не подходят.',
  },
  {
    id: 'zed',
    client: 'Zed',
    kind: 'json',
    label: 'Zed: settings.json',
    value: JSON.stringify({ context_servers: { [MCP_SERVER_KEY]: { url: MCP_ENDPOINT } } }, null, 2),
  },
  {
    // Goose (goose-docs.ai, 16.10): поле адреса — uri, не url.
    id: 'goose',
    client: 'Goose',
    kind: 'yaml',
    label: 'Goose: ~/.config/goose/config.yaml',
    value: [
      'extensions:',
      `  ${MCP_SERVER_KEY}:`,
      `    name: ${MCP_SERVER_KEY}`,
      '    type: streamable_http',
      `    uri: ${MCP_ENDPOINT}`,
      '    enabled: true',
      '    timeout: 300',
    ].join('\n'),
  },
  {
    // Cherry Studio (исходник main 2.1.6, 16.10): каноническое значение —
    // streamableHttp; импорт сервера создаёт его выключенным.
    id: 'cherry_studio',
    client: 'Cherry Studio',
    kind: 'json',
    label: 'Cherry Studio: Настройки → MCP → Импорт из JSON',
    value: JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { type: 'streamableHttp', url: MCP_ENDPOINT } } }, null, 2),
    note: 'Импортированный сервер создаётся выключенным — включите его переключателем.',
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
    // Гемини CLI вручную: Streamable HTTP — поле httpUrl (см. gemini_cli).
    id: 'gemini_settings',
    client: 'Gemini CLI',
    kind: 'json',
    label: 'Gemini CLI: ~/.gemini/settings.json',
    value: JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { httpUrl: MCP_ENDPOINT } } }, null, 2),
  },
  {
    // Qwen Chat Desktop: Настройки → MCP → Add MCP (16.10, по описанию
    // приложения; в веб-версии chat.qwen.ai своего MCP нет).
    id: 'qwen_chat',
    client: 'Qwen Chat Desktop',
    kind: 'json',
    label: 'Qwen Chat Desktop: Настройки → MCP → Add MCP → Streamable HTTP',
    value: JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { type: 'streamable-http', url: MCP_ENDPOINT } } }, null, 2),
    note: 'Живьём не проверено. Только в десктопном приложении; в форме выберите тип Streamable HTTP и вставьте адрес или этот JSON.',
  },
  {
    // Kimi: персональный плагин из MCP (kimi.com/en/help/plugins-and-skills/create).
    id: 'kimi',
    client: 'Kimi',
    kind: 'steps',
    label: 'Kimi (kimi.com): персональный плагин',
    value: `kimi.com → Plugins → Create plugin → MCP Server URL: ${MCP_ENDPOINT} (или импорт из MCP Registry: ru.vedarai/mcp) → Auth: None → Save`,
    note: 'Живьём не проверено: названия пунктов меню могут отличаться.',
  },
  {
    id: 'grok',
    client: 'Grok',
    kind: 'steps',
    label: 'Grok (grok.com и xAI API)',
    value: `grok.com → Settings → Connectors → Add custom connector → URL: ${MCP_ENDPOINT} → без авторизации. В xAI API: tools: [{ "type": "mcp", "server_label": "${MCP_SERVER_KEY}", "server_url": "${MCP_ENDPOINT}" }]`,
    note: 'Путь в веб-интерфейсе живьём не проверен; доступность своих коннекторов зависит от тарифа.',
  },
  {
    // Coze: плагин на основе MCP (docs.coze.cn/guides_create_a_plugin_based_on_mcp).
    id: 'coze',
    client: 'Coze (ByteDance)',
    kind: 'steps',
    label: 'Coze: плагин из MCP',
    value: `coze.com → Workspace → Resources → + Plugin → Create based on MCP → URL: ${MCP_ENDPOINT} → Streamable HTTP, без авторизации → Publish`,
    note: 'Живьём не проверено; нужен вход в Coze (Google или телефон).',
  },
  {
    // Zhipu GLM Chat Completions: инструмент типа mcp (docs.bigmodel.cn).
    id: 'zhipu_glm',
    client: 'Zhipu GLM API',
    kind: 'json',
    label: 'Zhipu GLM API: tools типа mcp',
    value: JSON.stringify({
      model: 'glm-4.6',
      messages: [{ role: 'user', content: 'Какие туры на Камчатке есть на этой неделе?' }],
      tools: [{ type: 'mcp', mcp: { server_label: MCP_SERVER_KEY, server_url: MCP_ENDPOINT, transport_type: 'streamable-http' } }],
    }, null, 2),
    note: 'Живьём не проверено: имя модели и поля mcp сверьте с документацией BigModel.',
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
