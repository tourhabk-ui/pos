/**
 * lib/analytics/widget-census-types.ts — типы отчёта о виджете партнёра без
 * серверных зависимостей (аудит 15.10, WID-screens).
 *
 * Почему отдельный модуль: отчёт читают экраны в браузере — кабинет
 * оператора («Виджет на ваш сайт») и карточка оператора в админке. Сама
 * перепись (lib/analytics/widget-census.ts) ходит в DNS через
 * `node:dns/promises`, и сторож tests/unit/client-no-node-builtins.test.ts
 * идёт по цепочке импортов из клиента, не отличая `import type` от обычного.
 * Типы, лежавшие в переписи, тянули её в четыре клиентские цепочки, и CI на
 * main краснел бы. Здесь — только описания формы, ни одного импорта кроме
 * типов из lib/embed/widget-origin (он тоже без модулей Node).
 *
 * Перепись реэкспортирует всё отсюда: серверный код по-прежнему берёт типы
 * из widget-census, клиентский — только отсюда.
 */
import type { WidgetHostCheck, WidgetKind } from '@/lib/embed/widget-origin';

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

/** Разговоры чата виджета у партнёра за 30/90 дней и откуда они пришли. */
export interface WidgetChatSessions {
  sessions_30d: number; sessions_90d: number;
  user_messages_30d: number; user_messages_90d: number;
  listed_90d: number; unlisted_90d: number; not_sent_90d: number; origin_not_recorded_90d: number;
  last_at: string | null;
}

/** Заявки формы виджета у партнёра за 30/90 дней и откуда они пришли. */
export interface WidgetFormLeads {
  leads_30d: number; leads_90d: number; self_90d: number;
  listed_90d: number; unlisted_90d: number; not_sent_90d: number; origin_not_recorded_90d: number;
  last_at: string | null;
}

/** Псевдолиды чата (до 15.10) и сколько из них крон добивки отдал другим. */
export interface WidgetChatPseudoLeads {
  pseudo_30d: number; pseudo_90d: number; handed_to_other_operators_90d: number;
}

export interface FailedMeasure { measure: string; sqlstate: string }

/**
 * Отчёт одного партнёра (аудит 15.10, WID-screens, W7): те же четыре части,
 * что у переписи, теми же запросами. Только агрегаты — ни имён, ни телефонов
 * посетителей, ни текста разговоров.
 */
export interface PartnerWidgetReport {
  window: { telemetry_days: number; activity_days: [number, number] };
  partner: { slug: string | null; name: string; widget_enabled: boolean; widget_domains: string[] };
  telemetry_30d: PartnerTelemetry | null;
  chat_sessions: WidgetChatSessions | null;
  form_leads: WidgetFormLeads | null;
  chat_pseudo_leads: WidgetChatPseudoLeads | null;
  /**
   * Есть ли скрипт на главных. null — этим запросом сайт не опрашивался:
   * «не проверено», а не «нет» (§4.0). Итог пробы в базе не хранится, так
   * что свежий он только у того, кто пробу заказал.
   */
  site_probe: SiteProbe[] | null;
  failed_measures: FailedMeasure[];
  notes: string[];
}
