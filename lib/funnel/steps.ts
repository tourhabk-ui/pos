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
 *   stay_search              — поиск жилья с условиями (entityId = канал и
 *                              исход, lib/stay/demand.ts: web:found, agent:empty…)
 *   stay_booking_start       — первое касание формы брони жилья (entityId = id объекта)
 *   stay_external_booking    — переход на бронь на сайте самого объекта
 *                              (entityId = id объекта, миграция 1109)
 *   stay_phone_call          — нажата «Позвонить» на карточке объекта без своего
 *                              сайта брони (entityId = id объекта, миграция 1179)
 *   stay_message_click      — нажата ссылка на чат в мессенджере на карточке
 *                              объекта (entityId = id объекта, миграция 1181)
 *
 * Пять последних — счётчик спроса на жильё (решение владельца 29.09): платить
 * TravelLine за подключение (100 000 ₽ + минимум 200 000 ₽ в год) имеет смысл,
 * только когда видно, что жильё ищут. В NSM они НЕ входят: «активированная
 * поездка» определена стратегией 14.08, и расширять её молча нельзя.
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
  'stay_search',
  'stay_booking_start',
  'stay_external_booking',
  'stay_phone_call',
  'stay_message_click',
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/**
 * Шаги, которые пишет СЕРВЕР, а не маяк (#2882, 30.10). Маяк их не принимает
 * (`z.enum(FUNNEL_STEPS)` в приёмнике): «заявка отправлена» и «отказ» — факты
 * сервера, и браузер их не вправе сообщать за него.
 *
 *   booking_submitted — бронь тура заведена (lib/bookings/reserve, любая
 *                       дверь: форма сайта, Кузьмич, агент, запрос мест);
 *                       entity_id = id тура, source = created_via
 *   booking_rejected  — попытка брони отклонена; reason — код из
 *                       BOOKING_REJECT_REASONS, entity_id = id тура (если
 *                       назван), source = канал
 *
 * Просмотр карточки тура сюда по-прежнему не входит: его пишет собственная
 * метрика (page_views), владелец 08.08.
 */
export const SERVER_FUNNEL_STEPS = ['booking_submitted', 'booking_rejected'] as const;
export type ServerFunnelStep = (typeof SERVER_FUNNEL_STEPS)[number];

/** Все шаги воронки — для срезов и отчётов; маяк знает только FUNNEL_STEPS. */
export const ALL_FUNNEL_STEPS = [...FUNNEL_STEPS, ...SERVER_FUNNEL_STEPS] as const;
export type AnyFunnelStep = (typeof ALL_FUNNEL_STEPS)[number];

/**
 * Причины отказа в брони — коды, не текст. Шесть первых — коды
 * `ReserveError` (lib/bookings/reserve): новый код отказа там не соберётся,
 * пока не назван здесь (reason у booking_rejected типизирован этим словарём).
 * Остальные — отказы двери сайта до общего модуля и сбой сервера.
 */
export const BOOKING_REJECT_REASONS = [
  'NOT_FOUND',            // тура нет, снят с публикации или удалён
  'DATE_BLOCKED',         // оператор закрыл дату в календаре
  'MAX_EXCEEDED',         // запрошено больше, чем вмещает тур или дата
  'NO_SLOTS',             // мест на дату не осталось
  'OUT_OF_SEASON',        // даты нет в календаре, и она вне сезона тура
  'PRICE_UNKNOWN',        // размер группы вне ступеней цены
  'DATE_PAST',            // дата в прошлом (проверка формы сайта)
  'GUEST_EMAIL_REQUIRED', // гость без e-mail (форма сайта)
  'INVALID_FORM',         // форма не прошла проверку схемы
  'SERVER_ERROR',         // сбой сервера при заведении брони
] as const;
export type BookingRejectReason = (typeof BOOKING_REJECT_REASONS)[number];

/** Причина словами — для строк сводки и дайджеста. */
export const BOOKING_REJECT_REASON_RU: Record<BookingRejectReason, string> = {
  NOT_FOUND: 'тур не найден или снят с витрины',
  DATE_BLOCKED: 'дата закрыта оператором',
  MAX_EXCEEDED: 'группа больше вместимости',
  NO_SLOTS: 'мест на дату нет',
  OUT_OF_SEASON: 'дата вне сезона',
  PRICE_UNKNOWN: 'цена для группы не названа',
  DATE_PAST: 'дата в прошлом',
  GUEST_EMAIL_REQUIRED: 'гость без e-mail',
  INVALID_FORM: 'форма не прошла проверку',
  SERVER_ERROR: 'сбой сервера',
};

/** Действия исполнения — вторая половина «активированной поездки». */
export const EXECUTION_STEPS: readonly FunnelStep[] = [
  'plan_saved',
  'plan_sent_to_telegram',
  'partner_contact',
  'booking_start',
  'mchs_registration_start',
  'offline_bundle_download',
];
