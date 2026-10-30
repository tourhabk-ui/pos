/**
 * Версии протокола MCP: какую сервер называет на рукопожатии `initialize`
 * и какие принимает в `_meta` запроса без рукопожатия.
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * `initialize` отвечал константой `2024-11-05` — ревизией эпохи HTTP+SSE.
 * Сервер при этом с 27.07 живёт на Streamable HTTP, который появился только в
 * ревизии `2025-03-26`. То есть мы называли версию, которой не соответствуем,
 * и не называли ту, по которой реально работаем. Клиент, строго следующий
 * спеке, вправе на такой ответ отключиться: он попросил новую, получил
 * старую и не обязан её уметь.
 *
 * ── Правило спеки ─────────────────────────────────────────────────────────
 *
 * Клиент присылает в `initialize` версию, которую хочет. Сервер отвечает ЕЮ,
 * если поддерживает, иначе — самой новой из своих. Решение «жить с этим или
 * отключиться» принимает клиент. Сервер не угадывает и не завышает.
 *
 * ── Что прочитано в legacy-ревизиях ──────────────────────────────────────
 *
 * От сервера, который отдаёт только `tools/*` одиночными JSON-ответами,
 * legacy-ревизии требуют ровно то, что он делает:
 *   · 2025-03-26 — Streamable HTTP: один POST-эндпоинт, JSON-RPC в теле;
 *     обязывает принимать пакеты JSON-RPC — роут принимает;
 *   · 2025-06-18 — заголовок `MCP-Protocol-Version` от клиента на
 *     последующих запросах; неподдерживаемую версию в нём сервер ОБЯЗАН
 *     отвергнуть 400 (прежняя строка здесь «сервер, не ветвящийся по версии,
 *     его не читает» была неверна — проверка MCP 29.09), нет заголовка —
 *     считать 2025-03-26; структурный вывод и elicitation необязательны;
 *   · 2025-11-25 — у `serverInfo` появились `description`, `websiteUrl` и
 *     `icons` (сервер их отдаёт); ошибка в аргументах инструмента — результат
 *     с `isError`, а не ошибка протокола (так и было: неизвестен только
 *     инструмент — -32602); «MUST validate Origin» — отступление записано с
 *     причиной у `withCors` в app/api/mcp/route.ts. Задачи (tasks), режим
 *     URL у elicitation и инструменты в sampling — возможности, которых
 *     сервер не объявляет, а значит и не обязан.
 *
 * ── Две эпохи на одном адресе (30.10) ────────────────────────────────────
 *
 * Ревизия `2026-07-28` ломает рукопожатие: `initialize` в ней нет, версия и
 * возможности клиента идут в `_meta` КАЖДОГО запроса
 * (`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`), а
 * сервер обязан уметь `server/discover`. Спека называет это эпохами
 * (basic/versioning, «Terminology»): legacy — ревизии с `initialize`
 * (2025-11-25 и старше), modern — с метаданными на запросе. Сервер, умеющий
 * обе, — dual-era: эпоху выбирает то, как клиент начал разговор, —
 * `initialize` ведёт в legacy, `_meta` с версией — в modern.
 *
 * Отсюда ДВА списка, а не один, и путать их нельзя:
 *   · LEGACY — только их называет `initialize` (negotiateProtocolVersion):
 *     ответить на рукопожатие ревизией, в которой рукопожатия нет, значит
 *     назвать то, чем этот разговор не является;
 *   · MODERN — только их принимает `_meta` запроса; legacy-версия в `_meta`
 *     получает UnsupportedProtocolVersionError, как и незнакомая.
 * Общий SUPPORTED_PROTOCOL_VERSIONS — для того, кто описывает адрес снаружи:
 * карточка сервера (lib/mcp/server-card.ts), OpenAPI, `data.supported` в
 * отказе по версии и `supportedVersions` в `server/discover`. Пример отказа
 * в самой спеке перечисляет обе эпохи (`["2026-07-28", "2025-11-25"]`).
 *
 * Партнёрский сервер (`/api/mcp/partner`) — только legacy: его заголовок
 * проверяется по isLegacyProtocolVersion, и modern-клиент получает там
 * прежний отказ по версии, а не молчаливое обслуживание по старым правилам.
 *
 * Что 2026-07-28 потребовала от кода (app/api/mcp/route.ts, ветка modern):
 * сверку заголовков `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` с телом
 * (base64-форма `=?base64?…?=` декодируется до сравнения; несовпадение —
 * -32020 и HTTP 400), `-32602` и 400 на запрос без обязательных полей
 * `_meta`, `-32022` с `data.supported` и 400 на чужую версию, HTTP 404 и
 * `-32601` на метод, которого сервер не знает (`initialize` и `ping` в этой
 * ревизии удалены), `resultType: "complete"` и `serverInfo` в `_meta` каждого
 * результата, `ttlMs`/`cacheScope` у `tools/list` и `server/discover`.
 * Пакетов JSON-RPC в 2026-07-28 нет: тело POST — одно сообщение.
 *
 * Появится прочитанная ревизия — добавляется в голову своего списка вместе
 * с тем, что она потребовала от кода. Список без причины не растёт.
 */

/** Ревизии с рукопожатием `initialize`, от новой к старой. Первая называется незнакомому клиенту. */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** Ревизии с версией в `_meta` каждого запроса, от новой к старой. */
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;

/** Обе эпохи, от новой к старой: так адрес описывается снаружи. */
export const SUPPORTED_PROTOCOL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Новейшая из тех, что может назвать `initialize`. */
export const LATEST_LEGACY_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0];

function inList(list: readonly string[], v: string): boolean {
  return list.includes(v.trim());
}

/** Версия из заголовка MCP-Protocol-Version — из любой нашей эпохи. */
export function isSupportedProtocolVersion(v: string): boolean {
  return inList(SUPPORTED_PROTOCOL_VERSIONS, v);
}

/** Версия эпохи `initialize` — единственная, что понимает партнёрский сервер. */
export function isLegacyProtocolVersion(v: string): boolean {
  return inList(LEGACY_PROTOCOL_VERSIONS, v);
}

/** Версия эпохи метаданных на запросе. */
export function isModernProtocolVersion(v: string): boolean {
  return inList(MODERN_PROTOCOL_VERSIONS, v);
}

/**
 * Версия для ответа на `initialize`.
 *
 * Запрошенная и поддерживаемая legacy — она же. Незнакомая, пустая, не
 * строка или modern (в ней `initialize` нет) — новейшая legacy: спека велит
 * отвечать версией, которую сервер умеет, а не молчать и не выдумывать.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && isLegacyProtocolVersion(requested)) return requested.trim();
  return LATEST_LEGACY_PROTOCOL_VERSION;
}
