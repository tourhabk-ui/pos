/**
 * lib/mcp/modelscope-listing.ts — внесены ли мы в каталог MCP ModelScope (魔搭 MCP广场).
 *
 * ── Откуда (находка аудита 15.10, CN-modelscope) ─────────────────────────
 *
 * Заявка `vedar-kamchatka` подана 14.10 открытой формой площадки, без аккаунта
 * (docs/agents/CHINA.md, шаг 1). Проверять внесение было нечем, кроме глаз
 * человека на странице каталога, а страница врёт: HTML
 * /mcp/servers/vedar/vedar-kamchatka отвечает 200 и ставит наше имя в
 * <title> для ЛЮБОГО slug — заголовок собирается из адреса. Разведка 15.10
 * нашла открытый API каталога, которому аккаунт не нужен:
 *
 *   PUT https://www.modelscope.cn/openapi/v1/mcp/servers
 *       {"search":"vedar","page_number":1,"page_size":10}
 *   → {"success":true,"data":{"mcp_server_list":[...],"total_count":N}}
 *
 * ── Три исхода (§4.0) ────────────────────────────────────────────────────
 *
 * Ноль по «vedar» сам по себе ничего не доказывает: поиск мог умереть,
 * сменить форму ответа или отдать пустоту всем. Поэтому ноль принимается за
 * «нас нет» только рядом с контрольным поиском «amap», который обязан найти
 * хоть что-то (15.10 — 13 записей, в каталоге всего 4746). Контроль не
 * ответил или тоже ноль — исход «не смог проверить», а не «нас нет».
 *
 * Найденную запись читаем вторым запросом GET /openapi/v1/mcp/servers/<id>
 * по id ИЗ ОТВЕТА поиска: только в карточке есть `is_hosted` и
 * `server_config`. Режим решает охват: Cherry Studio и Kimi Playground берут
 * только hosted-сервисы, запись «仅分发展示» (только показ) до них не дойдёт.
 *
 * GET по угаданному id доказательством отсутствия НЕ служит и здесь не
 * делается: формат id заранее неизвестен (встречаются `@amap/amap-maps` и
 * `dingtalk/Amap`), и 404 по догадке значил бы «не угадали», а не «нас нет».
 *
 * Модуль без импортов: workflow гоняет его через tsx без `npm ci`, а тест —
 * с подменённым fetch. Запускающий — scripts/modelscope-listing-check.ts,
 * workflow — .github/workflows/modelscope-listing.yml (только маркер и
 * ручной запуск, без расписания). Сторож — tests/unit/modelscope-listing.test.ts.
 */

export const MODELSCOPE_SERVERS_API = 'https://www.modelscope.cn/openapi/v1/mcp/servers';

/** Чем нас ищут: разработчик в заявке — `vedar`, имя — `vedar-kamchatka`. */
export const MODELSCOPE_OUR_QUERY = 'vedar';

/** Контроль живости поиска: у Amap в каталоге есть записи заведомо. */
export const MODELSCOPE_CONTROL_QUERY = 'amap';

/** День подачи формы — для текста «ждём»; срок разбора по справке площадки — до трёх рабочих дней. */
export const MODELSCOPE_SUBMITTED_ON = '2026-10-14';

/**
 * По чему запись в выдаче признаётся нашей. Поиск нечёткий, и «total_count > 0»
 * само по себе могло бы оказаться чужой записью — тогда это не «внесены», а
 * повод разобрать выдачу глазами.
 */
const OUR_MARKERS = ['vedar', '维达尔'];

const DEFAULT_TIMEOUT_MS = 30_000;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: 'GET' | 'PUT'; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface ModelScopeCard {
  /** `true` — 可托管部署, `false` — 仅分发展示, `null` — поля нет или не того типа. */
  isHosted: boolean | null;
  /** Как есть из карточки — для сводки. */
  serverConfig: unknown;
  /** Адреса `url` из server_config. */
  serverUrls: string[];
}

export type ModelScopeListing =
  | {
      outcome: 'listed';
      id: string;
      /** Другие наши записи в выдаче, если их больше одной (повторная подача). */
      alsoFound: string[];
      card: ModelScopeCard | null;
      /** Почему карточка не прочиталась; `null`, если прочиталась. */
      cardError: string | null;
    }
  | { outcome: 'not_listed'; controlTotal: number }
  | { outcome: 'unknown'; reason: string };

type Ask<T> = { ok: true; value: T } | { ok: false; reason: string };

interface SearchItem {
  id: string;
  names: string[];
}

interface SearchPage {
  total: number;
  items: SearchItem[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clip(s: string, n = 200): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

async function askJson(
  fetchImpl: FetchLike,
  url: string,
  init: { method: 'GET' | 'PUT'; body?: string },
  timeoutMs: number,
): Promise<Ask<unknown>> {
  let res: FetchLikeResponse;
  try {
    res = await fetchImpl(url, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `сеть: ${errText(e)}` };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, reason: `HTTP ${res.status}, тело не прочитано: ${errText(e)}` };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${clip(text)}` };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, reason: `HTTP ${res.status}, тело не JSON (${errText(e)}): ${clip(text)}` };
  }
}

function itemNames(item: Record<string, unknown>): string[] {
  const names: unknown[] = [item.id, item.name, item.chinese_name, item.publisher];
  if (isRecord(item.locales)) {
    for (const loc of Object.values(item.locales)) {
      if (isRecord(loc)) names.push(loc.name);
    }
  }
  return names.filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/** Разбор ответа поиска; форма не та — отказ с причиной, а не «ноль». */
export function parseSearchAnswer(body: unknown): Ask<SearchPage> {
  if (!isRecord(body)) return { ok: false, reason: 'ответ поиска — не объект' };
  if (body.success !== true) return { ok: false, reason: `success=${JSON.stringify(body.success)} (${clip(JSON.stringify(body))})` };
  const data = body.data;
  if (!isRecord(data)) return { ok: false, reason: 'в ответе поиска нет data' };
  const total = data.total_count;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    return { ok: false, reason: `total_count не число: ${JSON.stringify(total)}` };
  }
  if (!Array.isArray(data.mcp_server_list)) return { ok: false, reason: 'mcp_server_list не массив' };
  const items: SearchItem[] = [];
  for (const raw of data.mcp_server_list) {
    if (isRecord(raw) && typeof raw.id === 'string' && raw.id.length > 0) {
      items.push({ id: raw.id, names: itemNames(raw) });
    }
  }
  return { ok: true, value: { total, items } };
}

function serverUrlsOf(config: unknown): string[] {
  const out: string[] = [];
  const configs = Array.isArray(config) ? config : [config];
  for (const c of configs) {
    if (!isRecord(c) || !isRecord(c.mcpServers)) continue;
    for (const server of Object.values(c.mcpServers)) {
      if (isRecord(server) && typeof server.url === 'string') out.push(server.url);
    }
  }
  return out;
}

/** Разбор карточки GET /openapi/v1/mcp/servers/<id>. */
export function parseCardAnswer(body: unknown): Ask<ModelScopeCard> {
  if (!isRecord(body)) return { ok: false, reason: 'ответ карточки — не объект' };
  if (body.success !== true) return { ok: false, reason: `success=${JSON.stringify(body.success)} (${clip(JSON.stringify(body))})` };
  const data = body.data;
  if (!isRecord(data)) return { ok: false, reason: 'в карточке нет data' };
  const serverConfig = data.server_config ?? null;
  return {
    ok: true,
    value: {
      isHosted: typeof data.is_hosted === 'boolean' ? data.is_hosted : null,
      serverConfig,
      serverUrls: serverUrlsOf(serverConfig),
    },
  };
}

function isOurs(item: SearchItem): boolean {
  return item.names.some((n) => {
    const low = n.toLowerCase();
    return OUR_MARKERS.some((m) => low.includes(m));
  });
}

/** id в адресе: каждый сегмент кодируется, косая черта остаётся (`@amap/amap-maps`). */
export function cardUrl(id: string): string {
  return `${MODELSCOPE_SERVERS_API}/${id.split('/').map(encodeURIComponent).join('/')}`;
}

async function search(fetchImpl: FetchLike, query: string, timeoutMs: number): Promise<Ask<SearchPage>> {
  const asked = await askJson(
    fetchImpl,
    MODELSCOPE_SERVERS_API,
    { method: 'PUT', body: JSON.stringify({ search: query, page_number: 1, page_size: 10 }) },
    timeoutMs,
  );
  return asked.ok ? parseSearchAnswer(asked.value) : asked;
}

export async function checkModelScopeListing(
  fetchImpl: FetchLike,
  opts: { timeoutMs?: number } = {},
): Promise<ModelScopeListing> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ours = await search(fetchImpl, MODELSCOPE_OUR_QUERY, timeoutMs);
  if (!ours.ok) {
    return { outcome: 'unknown', reason: `поиск «${MODELSCOPE_OUR_QUERY}» не ответил: ${ours.reason}` };
  }

  if (ours.value.total > 0) {
    const mine = ours.value.items.filter(isOurs);
    if (mine.length === 0) {
      const ids = ours.value.items.map((i) => i.id).join(', ') || 'список пуст';
      return {
        outcome: 'unknown',
        reason:
          `поиск «${MODELSCOPE_OUR_QUERY}» вернул ${ours.value.total} записей, ни одна не называет ` +
          `${OUR_MARKERS.join('/')} в id или имени (${ids}) — разобрать выдачу глазами`,
      };
    }
    const [first, ...rest] = mine;
    const asked = await askJson(fetchImpl, cardUrl(first.id), { method: 'GET' }, timeoutMs);
    const card = asked.ok ? parseCardAnswer(asked.value) : asked;
    return {
      outcome: 'listed',
      id: first.id,
      alsoFound: rest.map((i) => i.id),
      card: card.ok ? card.value : null,
      cardError: card.ok ? null : card.reason,
    };
  }

  // Ноль по нам. Верить ему можно только при живом поиске.
  const control = await search(fetchImpl, MODELSCOPE_CONTROL_QUERY, timeoutMs);
  if (!control.ok) {
    return {
      outcome: 'unknown',
      reason: `по «${MODELSCOPE_OUR_QUERY}» ноль, но контрольный поиск «${MODELSCOPE_CONTROL_QUERY}» не ответил (${control.reason}) — ноль не доказан`,
    };
  }
  if (control.value.total === 0) {
    return {
      outcome: 'unknown',
      reason: `по «${MODELSCOPE_OUR_QUERY}» ноль, и по контрольному «${MODELSCOPE_CONTROL_QUERY}» тоже ноль — поиск каталога не работает, ноль ничего не значит`,
    };
  }
  return { outcome: 'not_listed', controlTotal: control.value.total };
}

export interface ModelScopeReport {
  headline: string;
  lines: string[];
  /** Команда GitHub Actions одной строкой: ::notice:: / ::warning:: / ::error::. */
  annotation: string;
  /** 0 — внесены; 1 — нет или не смог (оба не «хорошо», различаются аннотацией и сводкой). */
  exitCode: 0 | 1;
  serverConfig: unknown;
}

/** Экранирование данных в команде workflow: перевод строки иначе оборвёт её. */
export function escapeAnnotation(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function reportModelScopeListing(r: ModelScopeListing): ModelScopeReport {
  if (r.outcome === 'unknown') {
    return {
      headline: 'не смог проверить',
      lines: [
        `Причина: ${r.reason}.`,
        '«Не смог» не равно «нас нет»: повторить прогон; если повторяется — смотреть ответ API глазами.',
      ],
      annotation: `::warning::${escapeAnnotation(`ModelScope: не смог проверить внесение — ${r.reason}`)}`,
      exitCode: 1,
      serverConfig: null,
    };
  }

  if (r.outcome === 'not_listed') {
    return {
      headline: 'нас в каталоге нет',
      lines: [
        `Поиск «${MODELSCOPE_OUR_QUERY}» — 0 записей; контрольный «${MODELSCOPE_CONTROL_QUERY}» — ${r.controlTotal} (поиск жив, ноль настоящий).`,
        `Заявка подана открытой формой ${MODELSCOPE_SUBMITTED_ON}; по справке площадки разбор до трёх рабочих дней.`,
        'Если срок прошёл, а нас нет — подавать через консоль (вход через GitHub → 创建MCP服务), а не той же формой повторно (docs/agents/CHINA.md, шаг 1).',
      ],
      annotation: `::error::${escapeAnnotation(
        `ModelScope: по «${MODELSCOPE_OUR_QUERY}» ноль при живом поиске (контроль «${MODELSCOPE_CONTROL_QUERY}»: ${r.controlTotal}) — нас в каталоге нет`,
      )}`,
      exitCode: 1,
      serverConfig: null,
    };
  }

  const lines = [`id записи: \`${r.id}\` — вписать в lib/mcp/catalogs.ts.`];
  if (r.alsoFound.length > 0) lines.push(`Ещё наши записи в выдаче: ${r.alsoFound.join(', ')} — дубль подачи, лишнюю снять в консоли.`);
  const urls = r.card?.serverUrls ?? [];
  if (urls.length > 0) lines.push(`Адреса в server_config: ${urls.join(', ')}.`);

  if (r.card === null || r.card.isHosted === null) {
    const why = r.card === null ? `карточка не прочиталась: ${r.cardError ?? 'причина не названа'}` : 'в карточке нет поля is_hosted';
    lines.push(`Режим публикации не установлен — ${why}.`);
    return {
      headline: `внесены (${r.id}), режим не прочитан`,
      lines,
      annotation: `::warning::${escapeAnnotation(`ModelScope: внесены (${r.id}), но режим публикации не прочитан — ${why}`)}`,
      exitCode: 0,
      serverConfig: r.card?.serverConfig ?? null,
    };
  }

  if (!r.card.isHosted) {
    lines.push(
      'Режим «仅分发展示» (только показ): Cherry Studio и Kimi Playground берут лишь hosted-сервисы — до них мы не дойдём. ' +
        'Переключить на «可托管部署» в консоли (вход через GitHub).',
    );
    return {
      headline: `внесены (${r.id}), но только показом`,
      lines,
      annotation: `::warning::${escapeAnnotation(
        `ModelScope: внесены (${r.id}) только показом (仅分发展示) — Cherry Studio и Kimi Playground не подхватят; режим переключается в консоли`,
      )}`,
      exitCode: 0,
      serverConfig: r.card.serverConfig,
    };
  }

  lines.push('Режим «可托管部署» (хостинг): каталог видят Cherry Studio, Kimi Playground и Qoder CN.');
  return {
    headline: `внесены (${r.id}), режим хостинга`,
    lines,
    annotation: `::notice::${escapeAnnotation(`ModelScope: внесены (${r.id}), режим хостинга`)}`,
    exitCode: 0,
    serverConfig: r.card.serverConfig,
  };
}

/** Сводка job'а (GITHUB_STEP_SUMMARY), markdown. */
export function renderModelScopeSummary(rep: ModelScopeReport): string {
  const out = [`## ModelScope MCP广场 — ${rep.headline}`, '', ...rep.lines.map((l) => `- ${l}`), ''];
  if (rep.serverConfig !== null && rep.serverConfig !== undefined) {
    const json = JSON.stringify(rep.serverConfig, null, 2);
    out.push('server_config из карточки:', '', '```json', json.length > 2000 ? `${json.slice(0, 2000)}…` : json, '```', '');
  }
  return out.join('\n');
}
