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
 *     и каждую судит тем же правилом, что и домен из списка (probeSite);
 *     перед каждым запросом имя разрешается в DNS, и частный адрес — отказ.
 *     Домен сверх SITE_PROBE_MAX за прогон — could_not_check «не спрошен»,
 *     а не пропуск.
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
 *
 * Те же части по ОДНОМУ партнёру (widgetReportForPartner) читают экран
 * «Виджет на ваш сайт» в кабинете оператора и карточка оператора в админке
 * (аудит 15.10, WID-screens): запросы одни, второго счёта нет.
 */
import { lookup } from 'node:dns/promises';
import {
  classifyWidgetHost, normalizeWidgetHost,
  type WidgetKind,
} from '@/lib/embed/widget-origin';
import { isPrivateAddress } from '@/lib/security/site-audit';
import { decodeHtmlEntities } from '@/lib/html/entities';
import type {
  FailedMeasure, PartnerTelemetry, PartnerWidgetReport, SiteProbe,
  WidgetChatPseudoLeads, WidgetChatSessions, WidgetFormLeads,
} from '@/lib/analytics/widget-census-types';

// Типы отчёта живут в модуле без серверных зависимостей: их читают экраны в
// браузере, а этот модуль тянет node:dns/promises (аудит 15.10, WID-screens).
export type {
  FailedMeasure, PartnerTelemetry, PartnerWidgetReport, SiteProbe, SiteProbeOutcome, TelemetryByHost,
  WidgetChatPseudoLeads, WidgetChatSessions, WidgetFormLeads,
} from '@/lib/analytics/widget-census-types';

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
/**
 * Больше байт тела главной не читаем (аудит 15.10, R-census): чужой сервер
 * вправе отдать сотни мегабайт, а проб за прогон до двадцати разом. Предел
 * взят не по аналогии с lib/security/site-probe (там 200 КБ), а по замеру
 * 15.10: главная fishingkam.ru — 773 КБ, mestechkokam.ru — 236 КБ, то есть
 * 200 КБ не дочитали бы ни одну из двух настоящих. Скрипт за пределом не
 * виден — и это «не смог», а не «не нашёл» (probeSite).
 */
export const SITE_PROBE_BODY_LIMIT = 2_000_000;

interface Exec {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
/** Разрешатель имён в форме dns.lookup(…, { all: true }). */
export type ResolveLike = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

/** Сеть пробы: внедряется целиком, чтобы сторож подменял и fetch, и DNS. */
export interface ProbeIo {
  fetch: FetchLike;
  resolve: ResolveLike;
}

const systemResolve: ResolveLike = (hostname) => lookup(hostname, { all: true });

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
interface ChatRow extends WidgetChatSessions { partner_id: string }
interface FormRow extends WidgetFormLeads { partner_id: string }
interface PseudoRow extends WidgetChatPseudoLeads { partner_id: string }

export interface PartnerCensus {
  slug: string | null;
  name: string;
  widget_domains: string[];
  telemetry_30d: PartnerTelemetry | null;
  chat_sessions: WidgetChatSessions | null;
  form_leads: WidgetFormLeads | null;
  chat_pseudo_leads: WidgetChatPseudoLeads | null;
  site_probe?: SiteProbe[];
}

export interface WidgetCensusReport {
  window: { telemetry_days: number; activity_days: [number, number] };
  partners: PartnerCensus[] | null;
  failed_measures: FailedMeasure[];
  notes: string[];
}

export const CENSUS_NOTES: readonly string[] = [
  'Хост присылает браузер посетителя и подделывается: listed — «пришло с хостом из списка», а не доказательство, что с сайта партнёра. Сигнал, не замок.',
  'served — выдачи скрипта формы lead.js сервером, без кэша браузера: общее правило next.config.js отдаёт его с no-store и перебивает «5 минут» из заголовка самого роута, так что каждый просмотр страницы с кнопкой — выдача. Боты, назвавшие себя ботами, не считаются; неопознанные боты и повторные загрузки — считаются. Это верхняя граница просмотров страниц с кнопкой, а не их число. У чата served = null: embed.js — статический файл, его выдачу сервер не видит.',
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
 * Порты, которые проба вправе спросить: пустой (умолчание схемы — разбор URL
 * приводит `:443` у https и `:80` у http к пустому), 80 и 443. Главная сайта
 * живёт там; `:5432` или `:6379` в Location — это уже не главная, а чужая
 * служба за ней (аудит 15.10, R-census).
 */
const PROBE_PORTS = new Set(['', '80', '443']);

/**
 * Адрес, который проба вправе запросить. Одно правило — для домена из списка
 * и для КАЖДОЙ переадресации (аудит 15.10, W3-measure): только http/https,
 * порт 80/443 и публичное имя — не IP (любой: петля 127.x, частные 10.x и
 * 192.168.x, метаданные облака 169.254.169.254, IPv6), не localhost и не имя
 * частной сети. Судится РАЗОБРАННЫЙ адрес: разбор URL приводит «127.1»,
 * «0x7f.0.0.1» и «2130706433» к 127.0.0.1, то есть проверка видит то, куда
 * пойдёт fetch, а не строку, как её написали. `base` — адрес, относительно
 * которого разбирается относительный Location.
 *
 * Это правило ФОРМЫ. Куда имя разрешается, оно не знает — это судит
 * resolvedRefusal перед каждым запросом.
 */
export function probeableUrl(raw: string, base?: string): URL | null {
  if (!URL.canParse(raw, base)) return null;
  const url = new URL(raw, base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!PROBE_PORTS.has(url.port)) return null;
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

/**
 * Адрес lead.js в HTML: всё после `?` до конца значения атрибута. `&amp;` —
 * так амперсанд пишется внутри атрибута, и без разворота `partner` после него
 * читался бы как `amp;partner`. Разворот — общим decodeHtmlEntities (один
 * проход, одно место на платформу; сторож tests/unit/html-entities.test.ts).
 */
const LEAD_JS_QUERY_RE = /\/api\/widget\/lead\.js\?([^"'\s>]*)/gi;

/**
 * Наши скрипты в HTML главной: форма — lead.js, у которого параметр `partner`
 * равен slug ЦЕЛИКОМ; чат — embed.js с этим data-partner-id.
 *
 * Форма сверяется разбором параметра, а не подстрокой (аудит 15.10,
 * R-census): прежнее `includes('lead.js?partner=' + slug)` засчитывало
 * партнёру «fish» скрипт «fishingkam», а «mestechko» — скрипт «mestechko-2»,
 * то есть «found» там, где стоит чужая форма.
 */
export function detectWidgetScripts(html: string, slug: string): WidgetKind[] {
  const out: WidgetKind[] = [];
  const want = slug.toLowerCase();
  for (const m of html.matchAll(LEAD_JS_QUERY_RE)) {
    const partner = new URLSearchParams(decodeHtmlEntities(m[1])).get('partner');
    if (partner !== null && partner.toLowerCase() === want) {
      out.push('form');
      break;
    }
  }
  const chatAttr = new RegExp(`data-partner-id\\s*=\\s*["']?${escapeRe(slug)}(?:["'\\s>/]|$)`, 'i');
  if (html.toLowerCase().includes('/widget/embed.js') && chatAttr.test(html)) out.push('chat');
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

function logCancelFailure(what: string, err: unknown): void {
  console.warn(`[widget-census] ${what} не закрыто: ${err instanceof Error ? err.message : String(err)}`);
}

/** Тело не нужно, но соединение освобождаем; отказ закрытия — в лог, не в исход. */
function discardBody(res: Response): void {
  res.body?.cancel().catch((err: unknown) => logCancelFailure('тело ответа', err));
}

/**
 * Тело не больше `limit` байт: читается потоком и обрывается на пределе,
 * остаток не скачивается (reader.cancel). `truncated` — дочитали ли до конца.
 */
async function readCapped(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        parts.push(decoder.decode());
        return { text: parts.join(''), truncated: false };
      }
      const room = limit - bytes;
      if (value.byteLength > room) {
        parts.push(decoder.decode(value.subarray(0, room)));
        return { text: parts.join(''), truncated: true };
      }
      bytes += value.byteLength;
      parts.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.cancel().catch((err: unknown) => logCancelFailure('тело главной', err));
  }
}

/** Промис, который проигрывает сроку: dns.lookup сигнала не принимает. */
function withDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Куда имя разрешается — судится ПЕРЕД каждым запросом, и исходного домена,
 * и каждой переадресации (аудит 15.10, R-census). Правило формы
 * (probeableUrl) пропускает публичное имя, а `127.0.0.1.nip.io` или домен
 * партнёра с A-записью 10.x / 169.254.169.254 вели бы прод во внутреннюю
 * сеть. Частный адрес — то же правило isPrivateAddress, что у аудита сайтов
 * операторов (lib/security/site-audit). Хоть один частный адрес из всех —
 * отказ: какой из них выберет соединение, заранее не известно. Не
 * разрешилось — отказ («не знаю» здесь безопаснее «можно»). null — можно.
 *
 * Чего это не закрывает: fetch разрешает имя ещё раз сам, и сервер имён с
 * нулевым TTL может между двумя ответами сменить адрес (DNS rebinding). Это
 * тот же остаток, что у lib/security/site-probe.
 */
async function resolvedRefusal(hostname: string, resolve: ResolveLike, signal: AbortSignal): Promise<string | null> {
  let addrs: ReadonlyArray<{ address: string }>;
  try {
    addrs = await withDeadline(resolve(hostname), signal);
  } catch (err) {
    if (signal.aborted) throw err;
    const code = (err as { code?: string } | null)?.code;
    return `имя ${hostname} не разрешилось${code ? ` (${code})` : ''}`;
  }
  if (addrs.length === 0) return `имя ${hostname} не разрешилось: адресов нет`;
  const inner = addrs.find((a) => isPrivateAddress(a.address));
  return inner ? `имя ${hostname} разрешается в частный адрес ${inner.address}` : null;
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
 * Перед КАЖДЫМ запросом имя разрешается в DNS (resolvedRefusal): форма адреса
 * не говорит, куда он ведёт, и до R-census публичное имя с частным адресом
 * проходило. Тело главной читается не больше SITE_PROBE_BODY_LIMIT; скрипта
 * в прочитанном нет, а тело длиннее — «не смог», а не «не нашёл».
 */
export async function probeSite(
  domain: string,
  slug: string,
  io: ProbeIo,
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
  const limitMb = `${SITE_PROBE_BODY_LIMIT / 1_000_000} МБ`;
  try {
    let target = url;
    /** Переадресация, которая привела к target: её код и куда вела. */
    let via: { status: number; shown: string } | null = null;
    for (let hop = 0; ; hop += 1) {
      const refusal = await resolvedRefusal(new URL(target).hostname, io.resolve, signal);
      if (refusal) {
        return via
          ? couldNotCheck(via.status, `переадресация на ${via.shown}: ${refusal} — не запрашивался`)
          : couldNotCheck(null, `${refusal} — не запрашивался`);
      }
      const res = await io.fetch(target, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': 'VedarWidgetCensus/1 (+https://vedarai.ru)', accept: 'text/html' },
      });
      if (!REDIRECT_STATUSES.has(res.status)) {
        if (!res.ok) {
          discardBody(res);
          return couldNotCheck(res.status, `главная ответила HTTP ${res.status}`);
        }
        const { text, truncated } = await readCapped(res, SITE_PROBE_BODY_LIMIT);
        const scripts = detectWidgetScripts(text, slug);
        if (scripts.length === 0 && truncated) {
          return couldNotCheck(res.status, `главная длиннее ${limitMb}: в первых ${limitMb} скрипта нет, дальше не читали`);
        }
        return {
          domain, url,
          outcome: scripts.length > 0 ? 'found' : 'not_found',
          scripts, http_status: res.status,
          reason: truncated ? `главная длиннее ${limitMb}: скрипты искали только в первых ${limitMb}` : null,
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
          `переадресация на адрес вне правила пробы (не http/https, порт не 80/443, IP, localhost или частная сеть) — не запрашивался: ${redirectShown(location, target)}`,
        );
      }
      via = { status: res.status, shown: redirectShown(location, target) };
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

// ── Части отчёта: общие для переписи и экранов ──────────────────────────

/** Запуск одной части: отказ — в лог и в failed_measures, а не ноль (§4.0). */
type MeasureRun = <T>(measure: string, fn: () => Promise<T>) => Promise<T | null>;

function measureRunner(failed: FailedMeasure[], tag: string): MeasureRun {
  return async <T>(measure: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[${tag}] ${measure} не выполнен, SQLSTATE ${sqlstate(err)}`);
      failed.push({ measure, sqlstate: sqlstate(err) });
      return null;
    }
  };
}

/**
 * Четыре части по списку партнёров: выдачи и открытия, разговоры, заявки
 * формы, псевдолиды. Одна функция на перепись и на экраны кабинета и админки
 * (аудит 15.10, WID-screens): второй счёт разошёлся бы с переписью первым же
 * исправлением запроса.
 */
async function measureUsage(exec: Exec, partners: PartnerRow[], run: MeasureRun): Promise<PartnerCensus[]> {
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

  return partners.map((p) => {
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
}

interface ProbeOpts { fetchImpl?: FetchLike; resolveImpl?: ResolveLike }

/** Проба главных по доменам партнёров; кладёт итог в `site_probe` каждого. */
async function attachSiteProbes(out: PartnerCensus[], opts: ProbeOpts): Promise<void> {
  const io: ProbeIo = {
    fetch: opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init)),
    resolve: opts.resolveImpl ?? systemResolve,
  };
  const notAsked = (domain: string, reason: string): SiteProbe => (
    { domain, url: null, outcome: 'could_not_check', scripts: [], http_status: null, reason }
  );
  // Бюджет раздаётся ДО запросов, по порядку партнёров (PARTNERS_SQL), и
  // тратят его только домены, которые спрашиваются. Домен сверх бюджета
  // остаётся в ответе с причиной (аудит 15.10, R-census): прежде он
  // выпадал молча, и `site_probe: []` у партнёра с доменами читалось как
  // «проверять нечего», а не «не проверяли» (§4.0).
  let budget = SITE_PROBE_MAX;
  const plans = out.map((pc) => pc.widget_domains.map((domain) => {
    if (!pc.slug) return { domain, skip: 'у партнёра нет slug — искать нечего' };
    if (budget <= 0) return { domain, skip: `не спрошен: лимит ${SITE_PROBE_MAX} доменов за прогон исчерпан` };
    budget -= 1;
    return { domain, skip: null };
  }));
  await Promise.all(out.map(async (pc, i) => {
    const slug = pc.slug ?? '';
    pc.site_probe = await Promise.all(plans[i].map(({ domain, skip }) => (
      skip !== null ? notAsked(domain, skip) : probeSite(domain, slug, io)
    )));
  }));
}

// ── Перепись ─────────────────────────────────────────────────────────────

export async function censusWidgets(
  exec: Exec,
  opts: { probeSites?: boolean } & ProbeOpts = {},
): Promise<WidgetCensusReport> {
  const failed: FailedMeasure[] = [];
  const run = measureRunner(failed, 'widget-census');
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

  const out = await measureUsage(exec, partners, run);
  if (opts.probeSites) await attachSiteProbes(out, opts);
  return report(out);
}

// ── Отчёт одного партнёра: кабинет оператора и карточка в админке ──────────

/**
 * Один партнёр по id — включён виджет или нет: выключенный тоже вправе видеть
 * свою историю. Владение здесь не проверяется — его решает роут (свой кабинет
 * по SQL-связке до partners.user_id, или администратор).
 */
export const PARTNER_WIDGET_SQL = `
  SELECT id::text AS id, slug, name, COALESCE(widget_domains, '{}') AS widget_domains,
         COALESCE(widget_enabled, false) AS widget_enabled
    FROM partners
   WHERE id = $1::uuid`;

interface PartnerWidgetRow extends PartnerRow { widget_enabled: boolean }

export type PartnerWidgetOutcome =
  | { kind: 'ok'; report: PartnerWidgetReport }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; sqlstate: string };

/**
 * Три исхода (§4.0): отчёт; партнёра нет; не прочитали самого партнёра —
 * тогда и отчёт привязать не к чему, и роут отвечает 503, а не «данных нет».
 * Отказ ЧАСТИ отчёта — не исход, а null у этой части и строка в
 * failed_measures: остальное показывается.
 */
export async function widgetReportForPartner(
  exec: Exec,
  partnerId: string,
  opts: { probeSites?: boolean } & ProbeOpts = {},
): Promise<PartnerWidgetOutcome> {
  let row: PartnerWidgetRow | undefined;
  try {
    row = (await exec.query<PartnerWidgetRow>(PARTNER_WIDGET_SQL, [partnerId])).rows[0];
  } catch (err) {
    console.error(`[widget-report] партнёр не прочитан, SQLSTATE ${sqlstate(err)}`);
    return { kind: 'unavailable', sqlstate: sqlstate(err) };
  }
  if (!row) return { kind: 'not_found' };

  const failed: FailedMeasure[] = [];
  const [usage] = await measureUsage(exec, [row], measureRunner(failed, 'widget-report'));
  if (opts.probeSites) await attachSiteProbes([usage], opts);

  return {
    kind: 'ok',
    report: {
      window: { telemetry_days: TELEMETRY_DAYS, activity_days: [30, 90] },
      partner: {
        slug: row.slug,
        name: row.name,
        widget_enabled: row.widget_enabled === true,
        widget_domains: usage.widget_domains,
      },
      telemetry_30d: usage.telemetry_30d,
      chat_sessions: usage.chat_sessions,
      form_leads: usage.form_leads,
      chat_pseudo_leads: usage.chat_pseudo_leads,
      site_probe: usage.site_probe ?? null,
      failed_measures: failed,
      notes: [...CENSUS_NOTES],
    },
  };
}
