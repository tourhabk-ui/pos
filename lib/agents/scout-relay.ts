/**
 * lib/agents/scout-relay.ts — чтение источника разведки через реле вне РФ.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Прод живёт на Timeweb в РФ, и часть внешних ресурсов оттуда не читается:
 * гео-блок у самого ресурса (openai.com отвечает 403 российским адресам,
 * api.anthropic.com — тоже, см. lib/ai/provider-config.ts), либо блокировка
 * с нашей стороны (t.me). Разведчик такие источники не мог брать вовсе —
 * не потому, что они не нужны, а потому, что фетч уходит с прода.
 *
 * 03.09 сейсмо-реле (infra/safety-relay, воркер Cloudflare) доказало замером,
 * что страницы t.me с края Cloudflare читаются: /selftest принёс 106 и 114
 * килобайт двух каналов. Тот же воркер получил маршрут `/fetch` — прочитать
 * адрес из белого списка хостов и отдать тело. Этот модуль — клиентская
 * сторона: решить, идти ли через реле, и собрать адрес.
 *
 * ── Правила ────────────────────────────────────────────────────────────────
 *
 *   - реле — ФОЛБЭК, а не путь по умолчанию: сначала прямой запрос, реле
 *     только когда прямой не прошёл. Источник, читаемый из РФ, не зависит от
 *     Cloudflare и не платит лишний хоп;
 *   - на реле идут только отказы, похожие на блокировку: сетевая ошибка,
 *     403/451/429 и 5xx. 404 — это «ленты нет», реле её не найдёт;
 *   - исход называет путь: в отчёте здоровья у источника стоит `via: relay`.
 *     Иначе через месяц не отличить «читается из РФ» от «читается через
 *     Cloudflare», а это разные зависимости и разные поломки (§4.0);
 *   - без SCOUT_RELAY_BASE реле нет — разведчик работает как раньше. Урок
 *     OpenRouter (infra/ai-relay): «воркер вне РФ» не равно «обходит блок»,
 *     поэтому включение — решение по замеру, а не умолчание.
 */

export type FetchVia = 'direct' | 'relay';

/** Ответ прямого запроса, по которому решается, пробовать ли реле. */
export interface DirectOutcome {
  /** HTTP-статус прямого ответа; null — запрос не дошёл (сеть, таймаут). */
  status: number | null;
}

/** База реле из окружения; пустая строка — реле не настроено. */
export function relayBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SCOUT_RELAY_BASE ?? '').trim().replace(/\/+$/, '');
}

/** Разбирается ли база как https-адрес. Пустая — «не задана», а не «плохая». */
export function relayBaseValid(env: NodeJS.ProcessEnv = process.env): boolean {
  const base = relayBase(env);
  if (!base) return false;
  try {
    return new URL(base).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Состояние реле одним словом — для отчёта прогона: 'off' (адрес не задан),
 * 'bad_base' (задан, но не разбирается как https-адрес — так вышло 03.09,
 * когда в переменную на Timeweb попала строка с опечаткой из переписки),
 * 'on' (адрес и секрет на месте).
 */
export type RelayStatus = 'off' | 'bad_base' | 'on';

/**
 * ЧЕМ плох адрес реле — словами, для отчёта (03.09). `bad_base` называет
 * класс беды; человек в панели Timeweb чинит конкретную строку, и ему
 * нужно видеть, что именно не так: не https, или вовсе не адрес (в
 * переменную попала фраза из переписки). Значение показывается обрезанным:
 * это URL, не секрет, но чужой текст целиком в отчёте не нужен.
 * `null` — адреса нет или он в порядке.
 */
export function relayBaseProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = relayBase(env);
  if (!base) return null;
  const head = base.length > 24 ? `${base.slice(0, 24)}…` : base;
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:') return `адрес реле не https: «${head}» (${base.length} симв.)`;
    return null;
  } catch {
    return `адрес реле не разбирается как URL: «${head}» (${base.length} симв.) — в SCOUT_RELAY_BASE должен быть только https://…workers.dev`;
  }
}

export function relayStatus(env: NodeJS.ProcessEnv = process.env): RelayStatus {
  if (!relayBase(env)) return 'off';
  if (!relayBaseValid(env)) return 'bad_base';
  return (env.CRON_SECRET ?? '').trim().length > 0 ? 'on' : 'off';
}

/**
 * Настроено ли реле: нужны и адрес, и секрет, которым воркер закрыт. Адрес
 * обязан разбираться: с неразбираемым каждый фолбэк падал бы на разборе
 * адреса, а отчёт показывал бы «реле отказало» вместо «реле не настроено».
 */
export function relayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return relayStatus(env) === 'on';
}

/**
 * Стоит ли пробовать реле после прямого отказа.
 *
 * Сетевая ошибка — да: из РФ ресурс может не разрешаться или сбрасывать
 * соединение. 403/451 — да: так отвечает гео-блок. 429 и 5xx — да: у ресурса
 * за Cloudflare это часто «отказ по адресу клиента» (hnrss отдавал 502).
 * 404/410 — нет: ленты нет по этому адресу, реле её не найдёт, а попытка
 * замаскировала бы мёртвый фид под «блокировку».
 */
export function shouldFallbackToRelay(outcome: DirectOutcome): boolean {
  const s = outcome.status;
  if (s === null) return true;
  if (s === 403 || s === 451 || s === 429) return true;
  return s >= 500;
}

/** Адрес запроса к реле: `<base>/fetch?url=<адрес источника>`. */
export function relayFetchUrl(base: string, sourceUrl: string): string {
  return `${base.replace(/\/+$/, '')}/fetch?url=${encodeURIComponent(sourceUrl)}`;
}

/** Заголовки к реле: секрет — заголовком, не в адресной строке. */
export function relayHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { Authorization: `Bearer ${(env.CRON_SECRET ?? '').trim()}` };
}
