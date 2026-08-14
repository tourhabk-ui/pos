/**
 * Словарь именованных шагов воронки (стратегия 14.08, «активированные поездки»).
 *
 * ЕДИНСТВЕННЫЙ источник имён: клиентский маяк (lib/funnel/beacon.ts) и приёмник
 * (app/api/funnel/route.ts) читают шаги отсюда — расходиться им нечем. Просмотры
 * страниц сюда НЕ входят: их пишет собственная метрика (PageViewTracker →
 * page_views), маяк шлёт только ВЗАИМОДЕЙСТВИЯ, которых в page_views нет по
 * построению (владелец 08.08: «у нас была настроена своя метрика»).
 *
 * Смысл шагов:
 *   booking_start            — первое касание формы брони (entityId = id тура)
 *   planner_started          — первое осмысленное действие в анкете планировщика
 *   planner_result_viewed    — планировщик отдал план (дни получены и показаны)
 *   plan_saved               — план сохранён в поездки
 *   plan_sent_to_telegram    — план отправлен в Telegram (кнопка отправки)
 *   partner_contact          — открыт контакт исполнителя (entityId = партнёр/тур)
 *   mchs_registration_start  — переход к регистрации маршрута в МЧС из плана
 *   offline_bundle_download  — скачан офлайн-пакет плана (GPX)
 *
 * NSM «активированные поездки» = уникальные посетители за неделю с
 * planner_result_viewed И хотя бы одним действием исполнения (plan_saved,
 * plan_sent_to_telegram, partner_contact, booking_start,
 * mchs_registration_start, offline_bundle_download).
 */

export const FUNNEL_STEPS = [
  'booking_start',
  'planner_started',
  'planner_result_viewed',
  'plan_saved',
  'plan_sent_to_telegram',
  'partner_contact',
  'mchs_registration_start',
  'offline_bundle_download',
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** Действия исполнения — вторая половина «активированной поездки». */
export const EXECUTION_STEPS: readonly FunnelStep[] = [
  'plan_saved',
  'plan_sent_to_telegram',
  'partner_contact',
  'booking_start',
  'mchs_registration_start',
  'offline_bundle_download',
];
