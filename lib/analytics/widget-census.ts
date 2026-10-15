/**
 * lib/analytics/widget-census.ts — перепись виджетов партнёров: стоит ли
 * виджет и пользуются ли им (аудит 15.10, находка WID-measure, W6;
 * карт-бланш владельца 15.10).
 *
 * ── Повод ─────────────────────────────────────────────────────────────────
 *
 * На вопрос «стоит ли виджет у партнёра и пользуются ли им» ответа не было:
 * ни телеметрии, ни переписи. 15.10 «на mestechkokam.ru скрипта нет» узнали
 * ручным curl главной, а сколько заявок принесла форма у fishingkam, не
 * считал никто. Перепись отвечает по каждому партнёру с `widget_enabled`:
 *
 *   - домены из `widget_domains`;
 *   - выдачи скрипта формы и открытия окон за 30 дней по хосту
 *     (`widget_daily`, миграция 1282) — хост сверен со списком при чтении;
 *   - разговоры чата (`chat_sessions`, session_id `widget_<slug>_…`) за 30/90
 *     дней и откуда они пришли (`widget_origin.host_check`);
 *   - заявки формы (source 'partner_widget' или канал widget, кроме чата) за
 *     30/90 дней и откуда они пришли;
 *   - псевдолиды чата (до 15.10 чат делал «лид» из первого сообщения) и
 *     сколько из них крон добивки отдал ДРУГИМ операторам
 *     (`source_data ? 'notified_operators'`);
 *   - с `probe_sites` — есть ли наш скрипт на главной каждого домена:
 *     found / not_found / could_not_check. Переадресации проба идёт вручную
 *     и каждую судит тем же правилом, что и домен из списка (probeSite).
 *
 * ── Третье состояние (§4.0) ───────────────────────────────────────────────
 *
 * Каждая часть — свой запрос. Не прочиталась — у всех партнёров на её месте
 * null, а сама часть названа в `failed_measures` с SQLSTATE. «Ноль заявок» и
 * «запрос упал» — разные ответы. Проба сайта, не сумевшая проверить
 * (таймаут, 403, сеть), — could_not_check с причиной, а не not_found.
 *
 * Только чтение: ни INSERT, ни UPDATE нет ни при каком аргументе (сторож —
 * мок пула, пропускающий только SELECT).
 *
 * Хост — сигнал, а не замок: браузер присылает его сам, и подделать его может
 * кто угодно (lib/embed/widget-origin.ts).
 */
import {
  classifyWidgetHost, normalizeWidgetHost,
  type WidgetHostCheck, type WidgetKind,
} from '@/lib/embed/widget-origin';

export const TELEMETRY_DAYS = 30;
/** Таймаут пробы одного сайта. */
export const SITE_PROBE_TIMEOUT_MS = 10_000;
/** Больше доменов за прогон не спрашиваем: перепись — не обходчик. */
export const SITE_PROBE_MAX = 20;
/**
 * Больше переадресаций не идём: главная за тремя переходами — уже не
 * «главная домена», а цепочка, конец которой выбирает чужой сервер.
 */
export const SITE_PROBE_MAX_REDIRECTS = 3;

interface Exec {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const PARTNERS_SQL = `
  SELECT id::text AS id, slug, name, COALESCE(widget_domains, '{}') AS widget_domains
    FROM partners
   WHERE widget_enabled = true
   ORDER BY slug NULLS LAST, name`;

/** $1 — uuid[] партнёров. День — по Камчатке, как пишет производитель. */
export const TELEMETRY_SQL = `
  SELECT partner_id::text AS partner_id, host, widget,
         SUM(served)::int AS served,
         SUM(opened)::int AS opened,
         MAX(day)::text AS last_day
    FROM widget_daily
   WHERE partner_id = ANY($1::uuid[])
     AND day >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date - ${TELEMETRY_DAYS - 1}
   GROUP BY partner_id, host, widget
   ORDER BY partner_id, widget, opened DESC`;

/**
 * Разговоры чата: session_id пишет /api/widget/chat как `widget_<slug>_<id>`.
 * `_` и `%` в slug экранируются для LIKE, иначе slug «fish» собрал бы и
 * разговоры «fishingkam». Но и экранированный префикс неоднозначен, когда
 * один slug — продолжение другого через `_` («fish» и «fish_x»): разговор
 * `widget_fish_x_w_1` подходит обоим. Поэтому разговор достаётся партнёру с
 * САМЫМ ДЛИННЫМ подходящим slug — среди всех партнёров, а не только с
 * включённым виджетом (иначе разговоры выключенного ушли бы соседу).
 */
export const CHAT_SESSIONS_SQL = String.raw`
  WITH matched AS (
    SELECT DISTINCT ON (cs.session_id)
           p.id AS partner_id, cs.created_at, cs.updated_at, cs.user_message_count, cs.widget_origin
      FROM chat_sessions cs
      JOIN partners p
        ON p.slug IS NOT NULL
       AND cs.session_id LIKE 'widget\_' || replace(replace(replace(p.slug, '\', '\\'), '_', '\_'), '%', '\%') || '\_%'
     WHERE cs.session_id LIKE 'widget\_%'
       AND cs.created_at >= NOW() - INTERVAL '90 days'
     ORDER BY cs.session_id, length(p.slug) DESC
  )
  SELECT m.partner_id::text AS partner_id,
         COUNT(*) FILTER (WHERE m.created_at >= NOW() - INTERVAL '30 days')::int AS sessions_30d,
         COUNT(*)::int AS sessions_90d,
         COALESCE(SUM(m.user_message_count) FILTER (WHERE m.created_at >= NOW() - INTERVAL '30 days'), 0)::int AS user_messages_30d,
         COALESCE(SUM(m.user_message_count), 0)::int AS user_messages_90d,
         COUNT(*) FILTER (WHERE m.widget_origin->>'host_check' = 'listed')::int AS listed_90d,
         COUNT(*) FILTER (WHERE m.widget_origin->>'host_check' = 'unlisted')::int AS unlisted_90d,
         COUNT(*) FILTER (WHERE m.widget_origin->>'host_check' = 'not_sent')::int AS not_sent_90d,
         COUNT(*) FILTER (WHERE m.widget_origin IS NULL)::int AS origin_not_recorded_90d,
         MAX(m.updated_at)::text AS last_at
    FROM matched m
   WHERE m.partner_id = ANY($1::uuid[])
   GROUP BY m.partner_id`;

/**
 * Заявки формы виджета: source 'partner_widget' (так шлёт /widget/lead-form)
 * или канал widget, кроме чатового псевдолида (type 'widget').
 *
 * Партнёр у заявки ОДИН: адресат (`operator_id`), а slug из source_data —
 * только когда адресата нет (старая форма слала только его). Прежнее условие
 * `operator_id = p.id OR partner_slug = p.slug` (аудит 15.10, W3-measure)
 * считало заявку дважды, если адресат и slug в ней — разные партнёры: она
 * попадала и к адресату, и к партнёру со slug.
 */
export const FORM_LEADS_SQL = `
  SELECT p.id::text AS partner_id,
         COUNT(*) FILTER (WHERE l.created_at >= NOW() - INTERVAL '30 days')::int AS leads_30d,
         COUNT(*)::int AS leads_90d,
         COUNT(*) FILTER (WHERE l.is_self)::int AS self_90d,
         COUNT(*) FILTER (WHERE l.source_data->'widget_origin'->>'host_check' = 'listed')::int AS listed_90d,
         COUNT(*) FILTER (WHERE l.source_data->'widget_origin'->>'host_check' = 'unlisted')::int AS unlisted_90d,
         COUNT(*) FILTER (WHERE l.source_data->'widget_origin'->>'host_check' = 'not_sent')::int AS not_sent_90d,
         COUNT(*) FILTER (WHERE NOT COALESCE(l.source_data ? 'widget_origin', false))::int AS origin_not_recorded_90d,
         MAX(l.created_at)::text AS last_at
    FROM partners p
    JOIN leads l
      ON (l.operator_id = p.id
          OR (l.operator_id IS NULL AND l.source_data->>'partner_slug' = p.slug))
     AND l.created_at >= NOW() - INTERVAL '90 days'
     AND (
       l.source_data->>'source' = 'partner_widget'
       OR (l.source_channel = 'widget' AND COALESCE(l.source_data->>'type', '') <> 'widget')
     )
   WHERE p.id = ANY($1::uuid[])
   GROUP BY p.id`;

/**
 * Псевдолиды чата: /api/widget/chat до 15.10 создавал «лид» из первого
 * сообщения (type 'widget', partner_id = slug) без телефона и согласия, и
 * крон добивки отдавал его другим операторам — след `notified_operators`.
 */
export const CHAT_PSEUDO_LEADS_SQL = `
  SELECT p.id::text AS partner_id,
         COUNT(*) FILTER (WHERE l.created_at >= NOW() - INTERVAL '30 days')::int AS pseudo_30d,
         COUNT(*)::int AS pseudo_90d,
         COUNT(*) FILTER (WHERE l.source_data ? 'notified_operators')::int AS handed_to_other_operators_90d
    FROM partners p
    JOIN leads l
      ON l.source_data->>'type' = 'widget'
     AND l.source_data->>'partner_id' = p.slug
     AND l.created_at >= NOW() - INTERVAL '90 days'
   WHERE p.id = ANY($1::uuid[])
   GROUP BY p.id`;

interface PartnerRow { id: string; slug: string | null; name: string; widget_domains: string[] }
interface TelemetryRow { partner_id: string; host: string | null; widget: WidgetKind; served: number | null; opened: number; last_day: string }
interface ChatRow {
  partner_id: string; sessions_30d: number; sessions_90d: number;
  user_messages_30d: number; user_messages_90d: number;
  listed_90d: number; unlisted_90d: number; not_sent_90d: number; origin_not_recorded_90d: number;
  last_at: string | null;
}
interface FormRow {
  partner_id: string; leads_30d: number; leads_90d: number; self_90d: number;
  listed_90d: number; unlisted_90d: number; not_sent_90d: number; origin_not_recorded_90d: number;
  last_at: string | null;
}
interface PseudoRow { partner_id: string; pseudo_30d: number; pseudo_90d: number; handed_to_other_operators_90d: number }

export interface TelemetryByHost {
  host: string | null;
  host_check: WidgetHostCheck;
  widget: WidgetKind;
  /** У чата null: embed.js — статика, выдачу сервер не видит. */
  served: number | null;
  opened: number;
  last_day: string;
}

export interface PartnerTelemetry {
  form: { served: number; opened: number };
  chat: { served: null; opened: number };
  by_host: TelemetryByHost[];
}

export type SiteProbeOutcome = 'found' | 'not_found' | 'could_not_check';

export interface SiteProbe {
  domain: string;
  url: string | null;
  outcome: SiteProbeOutcome;
  /** Какие наши скрипты найдены на главной. */
  scripts: WidgetKind[];
  http_status: number | null;
  reason: string | null;
}

export interface PartnerCensus {
  slug: string | null;
  name: string;
  widget_domains: string[];
  telemetry_30d: PartnerTelemetry | null;
  chat_sessions: Omit<ChatRow, 'partner_id'> | null;
  form_leads: Omit<FormRow, 'partner_id'> | null;
  chat_pseudo_leads: Omit<PseudoRow, 'partner_id'> | null;
  site_probe?: SiteProbe[];
}

export interface FailedMeasure { measure: string; sqlstate: string }

export interface WidgetCensusReport {
  window: { telemetry_days: number; activity_days: [number, number] };
  partners: PartnerCensus[] | null;
  failed_measures: FailedMeasure[];
  notes: string[];
}

export const CENSUS_NOTES: readonly string[] = [
  'Хост присылает браузер посетителя и подделывается: listed — «пришло с хостом из списка», а не доказательство, что с сайта партнёра. Сигнал, не замок.',
  'served — выдачи скрипта формы lead.js сервером: нижняя граница просмотров (браузер держит скрипт 5 минут, боты не считаются). У чата served = null: embed.js — статический файл, его выдачу сервер не видит.',
  'opened — открытия окна по маяку (первый клик на странице); браузер без sendBeacon и CSP сайта партнёра, запрещающий запросы к vedarai.ru, маяк не пропускают — это тоже нижняя граница.',
  'origin_not_recorded — разговоры и заявки, записанные до миграции 1282 (или старым скриптом из кэша): откуда они пришли, неизвестно.',
  'site_probe ищет скрипт только на ГЛАВНОЙ домена: not_found значит «на главной нет», а не «нет на сайте».',
  'user_messages — сообщения человека, которые чат принял: сервер прибавляет 1 за каждое, присланная браузером история в счёт не идёт (окно её урезает). Дверь публичная, без входа — повторные запросы счёт накручивают, это сигнал, а не замок. Сообщение, чья запись в базу упала (SQLSTATE в логе), в счёт не попало.',
];

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

function byPartner<T extends { partner_id: string }>(rows: T[] | null): Map<string, T> | null {
  if (!rows) return null;
  return new Map(rows.map((r) => [r.partner_id, r]));
}

function strip<T extends { partner_id: string }>(row: T): Omit<T, 'partner_id'> {
  const { partner_id: _drop, ...rest } = row;
  void _drop;
  return rest;
}

const ZERO_CHAT: Omit<ChatRow, 'partner_id'> = {
  sessions_30d: 0, sessions_90d: 0, user_messages_30d: 0, user_messages_90d: 0,
  listed_90d: 0, unlisted_90d: 0, not_sent_90d: 0, origin_not_recorded_90d: 0, last_at: null,
};
const ZERO_FORM: Omit<FormRow, 'partner_id'> = {
  leads_30d: 0, leads_90d: 0, self_90d: 0,
  listed_90d: 0, unlisted_90d: 0, not_sent_90d: 0, origin_not_recorded_90d: 0, last_at: null,
};
const ZERO_PSEUDO: Omit<PseudoRow, 'partner_id'> = { pseudo_30d: 0, pseudo_90d: 0, handed_to_other_operators_90d: 0 };

function telemetryFor(rows: TelemetryRow[], domains: string[]): PartnerTelemetry {
  const by_host = rows.map((r) => ({
    host: r.host,
    host_check: classifyWidgetHost(r.host, domains),
    widget: r.widget,
    served: r.widget === 'chat' ? null : Number(r.served ?? 0),
    opened: Number(r.opened ?? 0),
    last_day: r.last_day,
  }));
  const sum = (w: WidgetKind, k: 'served' | 'opened') =>
    by_host.filter((h) => h.widget === w).reduce((s, h) => s + Number(h[k] ?? 0), 0);
  return {
    form: { served: sum('form', 'served'), opened: sum('form', 'opened') },
    chat: { served: null, opened: sum('chat', 'opened') },
    by_host,
  };
}

// ── Проба сайтов ─────────────────────────────────────────────────────────

/**
 * Имена частного пользования: в публичном DNS их нет, за ними — чья-то
 * внутренняя сеть (RFC 6761 `localhost`, RFC 6762 `.local`, RFC 8375
 * `.home.arpa`, зарезервированный ICANN `.internal`).
 */
const PRIVATE_NAME_RE = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/;

/**
 * Адрес, который проба вправе запросить. Одно правило — для домена из списка
 * и для КАЖДОЙ переадресации (аудит 15.10, W3-measure): только http/https и
 * публичное имя — не IP (любой: петля 127.x, частные 10.x и 192.168.x,
 * метаданные облака 169.254.169.254, IPv6), не localhost и не имя частной
 * сети. Судится РАЗОБРАННЫЙ адрес: разбор URL приводит «127.1», «0x7f.0.0.1»
 * и «2130706433» к 127.0.0.1, то есть проверка видит то, куда пойдёт fetch,
 * а не строку, как её написали. `base` — адрес, относительно которого
 * разбирается относительный Location.
 */
export function probeableUrl(raw: string, base?: string): URL | null {
  if (!URL.canParse(raw, base)) return null;
  const url = new URL(raw, base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // IPv6 в скобках и имя не в ASCII нормализацию хоста не проходят.
  const host = normalizeWidgetHost(url.hostname);
  if (!host || !host.includes('.')) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  if (PRIVATE_NAME_RE.test(host)) return null;
  return url;
}

/** Домен из записи списка — только похожий на публичный хост (правило probeableUrl). */
export function probeableDomain(raw: string): string | null {
  const cleaned = raw.trim().replace(/^https?:\/\//i, '').replace(/[/:].*$/, '');
  if (!normalizeWidgetHost(cleaned)) return null;
  const url = probeableUrl(`https://${cleaned}/`);
  return url ? normalizeWidgetHost(url.hostname) : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Наши скрипты в HTML главной: форма — lead.js с этим slug, чат — embed.js с этим data-partner-id. */
export function detectWidgetScripts(html: string, slug: string): WidgetKind[] {
  const out: WidgetKind[] = [];
  const lower = html.toLowerCase();
  if (lower.includes(`/api/widget/lead.js?partner=${slug.toLowerCase()}`)) out.push('form');
  const chatAttr = new RegExp(`data-partner-id\\s*=\\s*["']?${escapeRe(slug)}(?:["'\\s>/]|$)`, 'i');
  if (lower.includes('/widget/embed.js') && chatAttr.test(html)) out.push('chat');
  return out;
}

/**
 * Адрес переадресации для причины отказа — без query и hash: адрес на чужом
 * сайте может нести что угодно, а в ответе переписи нужно лишь «куда».
 * Не разбирается — названо словами, без исходной строки.
 */
export function redirectShown(location: string, base: string): string {
  if (!URL.canParse(location, base)) return 'адрес не разбирается';
  const u = new URL(location, base);
  return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 120);
}

/** Коды, по которым проба идёт дальше по Location. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Тело переадресации не нужно, но соединение освобождаем; отказ закрытия — в лог, не в исход. */
function discardBody(res: Response): void {
  res.body?.cancel().catch((err: unknown) => {
    console.warn(`[widget-census] тело переадресации не закрыто: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Есть ли наш скрипт на главной домена.
 *
 * Переадресации — ВРУЧНУЮ (аудит 15.10, W3-measure). С `redirect: 'follow'`
 * правило probeableUrl судило только исходный домен, а сайт вправе ответить
 * `302 Location: http://127.0.0.1/` или на 169.254.169.254, и fetch пошёл бы
 * туда с прода. Теперь каждый Location судится тем же правилом, переходов не
 * больше SITE_PROBE_MAX_REDIRECTS, а нарушение — could_not_check с причиной;
 * адрес за ним не запрашивается. Срок один на всю цепочку.
 *
 * Правило судит ФОРМУ адреса. Публичное имя, которое DNS разрешает в частный
 * адрес, оно не ловит: сверки DNS, как в lib/security/site-probe.ts, здесь нет.
 */
export async function probeSite(
  domain: string,
  slug: string,
  fetchImpl: FetchLike,
  timeoutMs: number = SITE_PROBE_TIMEOUT_MS,
): Promise<SiteProbe> {
  const host = probeableDomain(domain);
  if (!host) {
    return { domain, url: null, outcome: 'could_not_check', scripts: [], http_status: null, reason: 'запись списка не похожа на публичный домен' };
  }
  const url = `https://${host}/`;
  const couldNotCheck = (http_status: number | null, reason: string): SiteProbe => (
    { domain, url, outcome: 'could_not_check', scripts: [], http_status, reason }
  );
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const res = await fetchImpl(target, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': 'VedarWidgetCensus/1 (+https://vedarai.ru)', accept: 'text/html' },
      });
      if (!REDIRECT_STATUSES.has(res.status)) {
        if (!res.ok) return couldNotCheck(res.status, `главная ответила HTTP ${res.status}`);
        const html = await res.text();
        const scripts = detectWidgetScripts(html, slug);
        return {
          domain, url,
          outcome: scripts.length > 0 ? 'found' : 'not_found',
          scripts, http_status: res.status, reason: null,
        };
      }
      discardBody(res);
      if (hop >= SITE_PROBE_MAX_REDIRECTS) {
        return couldNotCheck(res.status, `больше ${SITE_PROBE_MAX_REDIRECTS} переадресаций — дальше не шли`);
      }
      const location = res.headers.get('location');
      if (!location) return couldNotCheck(res.status, `переадресация HTTP ${res.status} без адреса`);
      const next = probeableUrl(location, target);
      if (!next) {
        return couldNotCheck(
          res.status,
          `переадресация на адрес вне правила пробы (не http/https, IP, localhost или частная сеть) — не запрашивался: ${redirectShown(location, target)}`,
        );
      }
      target = next.href;
    }
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    const reason = name === 'TimeoutError' || name === 'AbortError'
      ? `нет ответа за ${Math.round(timeoutMs / 1000)} с`
      : `сеть: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
    return couldNotCheck(null, reason);
  }
}

// ── Перепись ─────────────────────────────────────────────────────────────

export async function censusWidgets(
  exec: Exec,
  opts: { probeSites?: boolean; fetchImpl?: FetchLike } = {},
): Promise<WidgetCensusReport> {
  const failed: FailedMeasure[] = [];
  const run = async <T>(measure: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[widget-census] ${measure} не выполнен, SQLSTATE ${sqlstate(err)}`);
      failed.push({ measure, sqlstate: sqlstate(err) });
      return null;
    }
  };
  const report = (partners: PartnerCensus[] | null): WidgetCensusReport => ({
    window: { telemetry_days: TELEMETRY_DAYS, activity_days: [30, 90] },
    partners,
    failed_measures: failed,
    notes: [...CENSUS_NOTES],
  });

  const partners = await run('partners', async () => (await exec.query<PartnerRow>(PARTNERS_SQL)).rows);
  if (!partners) {
    // Без списка партнёров остальные части не к чему привязать — названы явно.
    for (const measure of ['widget_daily', 'chat_sessions', 'form_leads', 'chat_pseudo_leads']) {
      failed.push({ measure, sqlstate: 'не выполнялся: не прочитан список партнёров' });
    }
    return report(null);
  }
  const ids = partners.map((p) => p.id);

  const [telemetry, chat, form, pseudo] = await Promise.all([
    run('widget_daily', async () => (await exec.query<TelemetryRow>(TELEMETRY_SQL, [ids])).rows),
    run('chat_sessions', async () => (await exec.query<ChatRow>(CHAT_SESSIONS_SQL, [ids])).rows),
    run('form_leads', async () => (await exec.query<FormRow>(FORM_LEADS_SQL, [ids])).rows),
    run('chat_pseudo_leads', async () => (await exec.query<PseudoRow>(CHAT_PSEUDO_LEADS_SQL, [ids])).rows),
  ]);
  const chatBy = byPartner(chat);
  const formBy = byPartner(form);
  const pseudoBy = byPartner(pseudo);

  const out: PartnerCensus[] = partners.map((p) => {
    const domains = Array.isArray(p.widget_domains) ? p.widget_domains : [];
    const chatRow = chatBy?.get(p.id);
    const formRow = formBy?.get(p.id);
    const pseudoRow = pseudoBy?.get(p.id);
    return {
      slug: p.slug,
      name: p.name,
      widget_domains: domains,
      telemetry_30d: telemetry ? telemetryFor(telemetry.filter((t) => t.partner_id === p.id), domains) : null,
      chat_sessions: chatBy ? (chatRow ? strip(chatRow) : { ...ZERO_CHAT }) : null,
      form_leads: formBy ? (formRow ? strip(formRow) : { ...ZERO_FORM }) : null,
      chat_pseudo_leads: pseudoBy ? (pseudoRow ? strip(pseudoRow) : { ...ZERO_PSEUDO }) : null,
    };
  });

  if (opts.probeSites) {
    const fetchImpl = opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
    let budget = SITE_PROBE_MAX;
    await Promise.all(out.map(async (pc) => {
      const slug = pc.slug;
      const domains = pc.widget_domains.slice(0, Math.max(0, budget));
      budget -= domains.length;
      pc.site_probe = slug
        ? await Promise.all(domains.map((d) => probeSite(d, slug, fetchImpl)))
        : domains.map((d) => ({
            domain: d, url: null, outcome: 'could_not_check' as const, scripts: [],
            http_status: null, reason: 'у партнёра нет slug — искать нечего',
          }));
    }));
  }

  return report(out);
}
