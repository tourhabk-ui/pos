/**
 * lib/analytics/lead-tracking.ts
 * Отслеживание событий для конверсионной воронки
 */

import { metrikaGoal, shouldTrackPath } from '@/lib/analytics/metrika';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export interface LeadEvent {
  event_name: string;
  event_category: string;
  event_label?: string;
  event_value?: number;
  route_id?: string;
  source?: string;
}

/**
 * Отправить событие в Yandex.Metrika
 * Используется для трекинга воронки: view → click → submit
 */
export function trackLeadEvent(event: LeadEvent) {
  if (typeof window === 'undefined') return;

  // Yandex.Metrika — номер счётчика один на платформу (lib/analytics/metrika).
  metrikaGoal(event.event_name, {
    category: event.event_category,
    label: event.event_label,
    value: event.event_value,
    route_id: event.route_id,
    source: event.source,
  });

  // Google Analytics (если подключен)
  if (window.gtag) {
    window.gtag('event', event.event_name, {
      event_category: event.event_category,
      event_label: event.event_label,
      value: event.event_value,
      route_id: event.route_id,
      source: event.source,
    });
  }

  // Отладочный вывод жил здесь безусловно и уезжал в прод (находка судьи
  // эволюции 08.09): CLAUDE.md запрещает console.log в продакшн-коде, а
  // событие лида несёт ещё и источник с маршрутом. В разработке он полезен —
  // поэтому не удалён, а поставлен под условие.
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[Lead Tracking]', event);
  }
}

/**
 * События конверсионной воронки
 */
export const LEAD_EVENTS = {
  // Просмотр маршрута
  VIEW_ROUTE: { event_name: 'view_route', event_category: 'routes' },

  // Клик на LeadButton
  CLICK_LEAD_BUTTON: { event_name: 'click_lead_button', event_category: 'cta' },

  // Открытие формы (step 1 — phone)
  OPEN_LEAD_FORM_PHONE: { event_name: 'open_lead_form_phone', event_category: 'form' },

  // Заполнение phone и переход к деталям
  LEAD_FORM_PHONE_FILLED: { event_name: 'lead_form_phone_filled', event_category: 'form' },

  // Открытие step 2 (детали)
  OPEN_LEAD_FORM_DETAILS: { event_name: 'open_lead_form_details', event_category: 'form' },

  // Отправка формы
  SUBMIT_LEAD: { event_name: 'submit_lead', event_category: 'conversion' },

  // Успешная отправка
  LEAD_SUCCESS: { event_name: 'lead_success', event_category: 'conversion' },

  // Ошибка при отправке
  LEAD_ERROR: { event_name: 'lead_error', event_category: 'error' },

  // Клик на affiliate link
  CLICK_AFFILIATE_LINK: { event_name: 'click_affiliate', event_category: 'monetization' },
} as const;

/** Откуда пришла успешная заявка — параметр цели `lead_success`. */
export type LeadSuccessSource = 'request_page' | 'booking_form' | 'kuzmich_widget';

/**
 * Цель «Заявка отправлена» (`lead_success`) — только после ответа сервера
 * «заявка записана». В параметрах — источник и номер тура, и ничего о
 * человеке: имя, телефон, почта и номер брони в Метрику не уходят.
 *
 * Путь проверяется ещё раз: `ym` остаётся в окне после перехода внутри
 * приложения, и без проверки цель ушла бы и с экранов, которые счётчик
 * видеть не должен (`METRIKA_EXCLUDED_PREFIXES`, например /hub).
 */
export function trackLeadSuccess(source: LeadSuccessSource, tourId?: string | number | null): void {
  if (typeof window === 'undefined') return;
  if (!shouldTrackPath(window.location.pathname)) return;
  trackLeadEvent({
    ...LEAD_EVENTS.LEAD_SUCCESS,
    source,
    route_id: tourId === null || tourId === undefined || tourId === '' ? undefined : String(tourId),
  });
}
