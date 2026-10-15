/**
 * lib/embed/widget-report-view.ts — отчёт о виджете партнёра словами для
 * экранов: кабинет оператора («Виджет на ваш сайт») и карточка оператора в
 * админке (аудит 15.10, находка WID-screens, W7).
 *
 * Числа приходят из той же логики, что перепись (widgetReportForPartner в
 * lib/analytics/widget-census.ts), и называются так же честно, как в её
 * CENSUS_NOTES:
 *
 *   - загрузки кнопки заявки — ВЕРХНЯЯ граница («до N»): считаются повторные
 *     загрузки и неопознанные боты;
 *   - открытия окон — НИЖНЯЯ граница («не меньше N»): браузер без маяка и
 *     сайт, запрещающий запросы к vedarai.ru, открытие не сообщают;
 *   - загрузки чата не измеряются вовсе: embed.js — статический файл;
 *   - часть, которая не прочиталась, — «не загрузилось», а не ноль (§4.0);
 *   - стоит ли код на сайте — только по пробе, сделанной этим запросом;
 *     нет пробы — «не проверено».
 *
 * Только агрегаты: ни имён, ни телефонов посетителей здесь нет и быть не
 * может — их нет в отчёте.
 *
 * Модуль без серверных зависимостей: им пользуются экраны в браузере
 * (из переписи — только типы).
 */
import type { PartnerWidgetReport, SiteProbe, TelemetryByHost } from '@/lib/analytics/widget-census';

// ── Разбор ответа ─────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): string | null => (isStr(v) ? v : null);

/** Объект с числовыми полями `keys` — иначе null («не загрузилось»). */
function numbers<K extends string>(v: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isObj(v)) return null;
  const out = {} as Record<K, number>;
  for (const k of keys) {
    if (!isNum(v[k])) return null;
    out[k] = v[k];
  }
  return out;
}

/** То же, плюс время последнего события (строка или null). */
function withLastAt<K extends string>(v: unknown, keys: readonly K[]): (Record<K, number> & { last_at: string | null }) | null {
  const n = numbers(v, keys);
  return n && isObj(v) ? { ...n, last_at: strOrNull(v.last_at) } : null;
}

const CHAT_KEYS = [
  'sessions_30d', 'sessions_90d', 'user_messages_30d', 'user_messages_90d',
  'listed_90d', 'unlisted_90d', 'not_sent_90d', 'origin_not_recorded_90d',
] as const;
const FORM_KEYS = [
  'leads_30d', 'leads_90d', 'self_90d',
  'listed_90d', 'unlisted_90d', 'not_sent_90d', 'origin_not_recorded_90d',
] as const;
const PSEUDO_KEYS = ['pseudo_30d', 'pseudo_90d', 'handed_to_other_operators_90d'] as const;

function parseTelemetry(v: unknown): PartnerWidgetReport['telemetry_30d'] {
  if (!isObj(v) || !isObj(v.form) || !isObj(v.chat) || !Array.isArray(v.by_host)) return null;
  if (!isNum(v.form.served) || !isNum(v.form.opened) || !isNum(v.chat.opened)) return null;
  const byHost: TelemetryByHost[] = [];
  for (const h of v.by_host) {
    if (!isObj(h) || !isNum(h.opened) || (h.widget !== 'form' && h.widget !== 'chat')) return null;
    if (h.host_check !== 'listed' && h.host_check !== 'unlisted' && h.host_check !== 'not_sent') return null;
    byHost.push({
      host: strOrNull(h.host),
      host_check: h.host_check,
      widget: h.widget,
      served: isNum(h.served) ? h.served : null,
      opened: h.opened,
      last_day: isStr(h.last_day) ? h.last_day : '',
    });
  }
  return {
    form: { served: v.form.served, opened: v.form.opened },
    chat: { served: null, opened: v.chat.opened },
    by_host: byHost,
  };
}

function parseProbes(v: unknown): SiteProbe[] | null {
  if (!Array.isArray(v)) return null;
  const out: SiteProbe[] = [];
  for (const p of v) {
    if (!isObj(p) || !isStr(p.domain)) continue;
    if (p.outcome !== 'found' && p.outcome !== 'not_found' && p.outcome !== 'could_not_check') continue;
    out.push({
      domain: p.domain,
      url: strOrNull(p.url),
      outcome: p.outcome,
      scripts: Array.isArray(p.scripts) ? p.scripts.filter((s): s is 'form' | 'chat' => s === 'form' || s === 'chat') : [],
      http_status: isNum(p.http_status) ? p.http_status : null,
      reason: strOrNull(p.reason),
    });
  }
  return out;
}

/**
 * Ответ роута → отчёт. Не узнали партнёра — null (экран скажет «не
 * загрузилось» целиком). Часть неожиданной формы — null у этой части: на
 * экране она «не загрузилась», а не стала нулём.
 */
export function parsePartnerWidgetReport(v: unknown): PartnerWidgetReport | null {
  if (!isObj(v) || !isObj(v.partner)) return null;
  const p = v.partner;
  if (!isStr(p.name) || typeof p.widget_enabled !== 'boolean' || !Array.isArray(p.widget_domains)) return null;
  const failed = Array.isArray(v.failed_measures)
    ? v.failed_measures
      .filter(isObj)
      .map((f) => ({ measure: isStr(f.measure) ? f.measure : '?', sqlstate: isStr(f.sqlstate) ? f.sqlstate : '?' }))
    : [];
  return {
    window: { telemetry_days: 30, activity_days: [30, 90] },
    partner: {
      slug: strOrNull(p.slug),
      name: p.name,
      widget_enabled: p.widget_enabled,
      widget_domains: p.widget_domains.filter(isStr),
    },
    telemetry_30d: parseTelemetry(v.telemetry_30d),
    chat_sessions: withLastAt(v.chat_sessions, CHAT_KEYS),
    form_leads: withLastAt(v.form_leads, FORM_KEYS),
    chat_pseudo_leads: numbers(v.chat_pseudo_leads, PSEUDO_KEYS),
    site_probe: v.site_probe === null || v.site_probe === undefined ? null : parseProbes(v.site_probe),
    failed_measures: failed,
    notes: Array.isArray(v.notes) ? v.notes.filter(isStr) : [],
  };
}

// ── Строки отчёта ─────────────────────────────────────────────────────────

/** Строка не загрузилась — так и пишется, нулём она не становится. */
export const NOT_LOADED = 'не загрузилось';
export const NOT_CHECKED = 'не проверено';

export interface ReportLine {
  key: 'form_served' | 'form_opened' | 'chat_served' | 'chat_opened' | 'chat_sessions' | 'form_leads';
  label: string;
  /** null — часть отчёта не прочиталась: «не загрузилось». */
  value: string | null;
  hint: string;
}

/** Отчёт за 30 дней: шесть строк, у каждой — граница словами. */
export function widgetReportLines(r: PartnerWidgetReport): ReportLine[] {
  const t = r.telemetry_30d;
  return [
    {
      key: 'form_served',
      label: 'Загрузки кнопки заявки',
      value: t ? `до ${t.form.served}` : null,
      hint: 'Верхняя граница просмотров страниц с кнопкой: повторные загрузки и неопознанные боты тоже считаются.',
    },
    {
      key: 'form_opened',
      label: 'Открытия формы заявки',
      value: t ? `не меньше ${t.form.opened}` : null,
      hint: 'Нижняя граница: браузер без маяка и сайт, запрещающий запросы к vedarai.ru, открытие не сообщают.',
    },
    {
      key: 'chat_served',
      label: 'Загрузки кнопки чата',
      value: 'не измеряется',
      hint: 'Скрипт чата — статический файл: его загрузку сервер не видит.',
    },
    {
      key: 'chat_opened',
      label: 'Открытия чата',
      value: t ? `не меньше ${t.chat.opened}` : null,
      hint: 'Нижняя граница — по той же причине, что у формы.',
    },
    {
      key: 'chat_sessions',
      label: 'Разговоры в чате',
      value: r.chat_sessions ? String(r.chat_sessions.sessions_30d) : null,
      hint: 'Окна, где посетитель написал хотя бы одно сообщение. Перезагрузка страницы начинает новый разговор, а чат открыт всем — это сигнал, а не число людей.',
    },
    {
      key: 'form_leads',
      label: 'Заявки с формы',
      value: r.form_leads ? String(r.form_leads.leads_30d) : null,
      hint: 'Заявки, оставленные формой виджета и записанные в базе.',
    },
  ];
}

const HOST_CHECK_LABEL: Record<TelemetryByHost['host_check'], string> = {
  listed: 'в списке доменов',
  unlisted: 'не в списке доменов',
  not_sent: 'адрес страницы не передан',
};

export interface HostLine {
  host: string;
  check: string;
  widget: 'форма' | 'чат';
  served: string | null;
  opened: string;
}

/**
 * Откуда пришли загрузки и открытия: хост страницы и его сверка со списком.
 * Хост присылает браузер и подделывается — это сигнал, а не доказательство.
 */
export function widgetHostLines(r: PartnerWidgetReport): HostLine[] | null {
  if (!r.telemetry_30d) return null;
  return r.telemetry_30d.by_host.map((h) => ({
    host: h.host ?? '—',
    check: HOST_CHECK_LABEL[h.host_check],
    widget: h.widget === 'form' ? 'форма' : 'чат',
    served: h.widget === 'form' && h.served !== null ? `до ${h.served}` : null,
    opened: `не меньше ${h.opened}`,
  }));
}

export interface SitePresence {
  /** Сводка одной строкой: «не проверено», «на главной есть» и т. п. */
  summary: string;
  domains: Array<{ domain: string; text: string }>;
}

const SCRIPT_NAMES: Record<'form' | 'chat', string> = { form: 'форма', chat: 'чат' };

/**
 * Стоит ли код на сайте. Без пробы этим запросом — «не проверено»: косвенные
 * признаки (загрузки, открытия) пробой не считаются.
 */
export function widgetSitePresence(r: PartnerWidgetReport): SitePresence {
  if (r.site_probe === null) return { summary: NOT_CHECKED, domains: [] };
  if (r.site_probe.length === 0) {
    return { summary: 'проверять нечего: домены не указаны', domains: [] };
  }
  const domains = r.site_probe.map((p) => ({
    domain: p.domain,
    text: p.outcome === 'found'
      ? `на главной есть: ${p.scripts.map((s) => SCRIPT_NAMES[s]).join(', ')}`
      : p.outcome === 'not_found'
        ? 'на главной нет (это не значит, что нет на других страницах)'
        : `не смог проверить${p.reason ? `: ${p.reason}` : ''}`,
  }));
  const found = r.site_probe.filter((p) => p.outcome === 'found').length;
  const unknown = r.site_probe.filter((p) => p.outcome === 'could_not_check').length;
  const summary = found > 0
    ? 'на главной есть'
    : unknown > 0
      ? 'не смог проверить'
      : 'на главной нет';
  return { summary, domains };
}
