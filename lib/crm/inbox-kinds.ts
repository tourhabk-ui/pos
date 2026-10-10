/**
 * lib/crm/inbox-kinds.ts — словарь «Входящих» партнёра (CRM #2325, шаг 1г):
 * какие предметы ждут ответа у какой роли, как они называются и где на них
 * отвечают. Без пула и без сервера — это читают и запросы, и экран.
 *
 * Ящик вычисляется из источников, своей таблицы данных у него нет: бронь в
 * статусе «новая» — уже входящее, подтверждение — уже ответ. Во «Входящие»
 * попадает только то, на что партнёр МОЖЕТ ответить из кабинета или по
 * ссылке, которую ему прислали: предмет без пути к ответу — тупик, и место
 * ему не здесь, а в `INBOX_NOT_HERE` с причиной.
 */
import type { PartnerCategory } from '@/lib/crm/partner-context';

export const INBOX_KINDS = [
  'operator_booking',
  'seat_request',
  'lead',
  'accommodation_booking',
  'gear_rental',
  'transfer_seat_booking',
  'guide_invite',
  'guide_review',
  'tour_review',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** Что ждёт ответа у роли. Порядок — порядок разделов на экране. */
export const INBOX_BY_CATEGORY: Readonly<Record<PartnerCategory, readonly InboxKind[]>> = {
  operator: ['seat_request', 'operator_booking', 'lead', 'tour_review'],
  stay: ['accommodation_booking'],
  gear: ['gear_rental'],
  transfer: ['transfer_seat_booking'],
  guide: ['guide_invite', 'guide_review'],
  agent: [],
};

/**
 * Чего во «Входящих» роли нет и почему — словами на экране. Молчание читалось
 * бы как «этого не бывает», а оно бывает: на это просто нельзя ответить отсюда.
 */
export const INBOX_NOT_HERE: Readonly<Record<PartnerCategory, readonly string[]>> = {
  operator: [
    'Заявки без оператора — в разделе «AI Заявки»: здесь только заявки, отданные вам.',
  ],
  stay: ['Отзывы о жилье: ответа на них на платформе пока нет.'],
  gear: [],
  transfer: [],
  guide: ['Назначение на бронь подтверждать не нужно — оно сразу в расписании.'],
  agent: ['У агента входящих пока нет: заявок и чата с туристами у роли ещё нет.'],
};

/** У каких ролей есть чат с туристами (виджет в кабинете) — им показываем непрочитанное. */
export const INBOX_CHAT_CATEGORIES: ReadonlySet<PartnerCategory> = new Set(['operator', 'guide']);

export const INBOX_KIND_LABELS: Readonly<Record<InboxKind, string>> = {
  operator_booking: 'Бронь тура',
  seat_request: 'Запрос мест',
  lead: 'Заявка на подбор',
  accommodation_booking: 'Бронь жилья',
  gear_rental: 'Заказ снаряжения',
  transfer_seat_booking: 'Места в машине',
  guide_invite: 'Приглашение в команду',
  guide_review: 'Отзыв без ответа',
  tour_review: 'Отзыв о туре без ответа',
};

/**
 * Где ответить. `null` — отдельного раздела нет: на запрос мест оператор
 * отвечает кнопками прямо во «Входящих» (components/crm/SeatRequestActions)
 * или в сообщении о запросе в MAX/Telegram. Контакты туриста открываются
 * только после «есть места» (решение 29.09).
 */
export const INBOX_ACTION: Readonly<Record<InboxKind, { href: string | null; hint: string }>> = {
  operator_booking: { href: '/hub/operator/bookings', hint: 'Подтвердить или отклонить в «Бронированиях»' },
  seat_request: { href: null, hint: 'Ответить во «Входящих» кабинета или в сообщении о запросе (MAX или Telegram), срок — 2 часа' },
  lead: { href: '/hub/operator/leads', hint: 'Ответить в «AI Заявках»' },
  accommodation_booking: { href: '/hub/stay/bookings', hint: 'Подтвердить или отклонить в «Бронях»' },
  gear_rental: { href: '/hub/gear/rentals', hint: 'Подтвердить или отклонить в «Арендах»' },
  transfer_seat_booking: { href: '/hub/carrier', hint: 'Ответить во вкладке «Запросы»' },
  guide_invite: { href: '/hub/guide', hint: 'Принять или отклонить в «Обзоре»' },
  guide_review: { href: '/hub/guide/reviews', hint: 'Ответить в «Отзывах»' },
  tour_review: { href: '/hub/operator/reviews', hint: 'Ответить в «Отзывах»' },
};

/**
 * Время первого ответа считается по просьбам клиента, где ответ ждут: брони,
 * заявки, приглашение. Отзыв без ответа во «Входящих» есть, но в медиану не
 * идёт: на отзыв отвечают не «быстро», а по делу.
 */
export const RESPONSE_METRIC_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>([
  'operator_booking', 'seat_request', 'lead', 'accommodation_booking',
  'gear_rental', 'transfer_seat_booking', 'guide_invite',
]);

/** Окно медианы и порог: меньше пяти ответов — «мало данных», а не число. */
export const RESPONSE_WINDOW_DAYS = 7;
export const RESPONSE_MIN_SAMPLE = 5;
/** Отзывы старше этого во «Входящих» не держатся — это уже не «ждёт ответа». */
export const REVIEW_WINDOW_DAYS = 30;
/** Предмет ждёт дольше — на экране он отмечен как просроченный (урок Tripster: 2 часа). */
export const INBOX_SLOW_MINUTES = 120;
