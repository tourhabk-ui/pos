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
import { ownerBookingsPath, ownerLeadsPath } from '@/lib/partners/cabinet-links';

export const INBOX_KINDS = [
  'operator_booking',
  'seat_request',
  'lead',
  'accommodation_booking',
  'stay_request',
  'gear_rental',
  'transfer_seat_booking',
  'guide_invite',
  'guide_review',
  'tour_review',
  'stay_review',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** Что ждёт ответа у роли. Порядок — порядок разделов на экране. */
export const INBOX_BY_CATEGORY: Readonly<Record<PartnerCategory, readonly InboxKind[]>> = {
  operator: ['seat_request', 'operator_booking', 'lead', 'tour_review'],
  // Заявка хозяину (1206) — у объекта «через владельца»: номеров и кабинета
  // нет, отвечают кнопкой в MAX или звонком (1348).
  stay: ['stay_request', 'accommodation_booking', 'stay_review'],
  gear: ['gear_rental'],
  transfer: ['transfer_seat_booking'],
  // Гид продаёт и свои туры (28.10, миграция 1338): брони, запросы мест и
  // заявки на них ждут его ответа так же, как у оператора, и запросы читают
  // по `operator_id` — карточке гида. На бронь и заявку он отвечает в разделе
  // «Свои туры» (заявка — с 29.10, `PATCH /api/guide/own/leads/[id]`), на
  // запрос мест — кнопками здесь же. Гиду без своих туров эти виды пусты.
  guide: ['seat_request', 'operator_booking', 'lead', 'guide_invite', 'guide_review'],
  agent: [],
};

/**
 * Чего во «Входящих» роли нет и почему — словами на экране. Молчание читалось
 * бы как «этого не бывает», а оно бывает: на это просто нельзя ответить отсюда.
 */
export const INBOX_NOT_HERE: Readonly<Record<PartnerCategory, readonly string[]>> = {
  operator: [
    'Заявки без оператора — в разделе «Заявки с сайта»: здесь только заявки, отданные вам.',
  ],
  stay: [],
  gear: [],
  // Трансфер — машина целиком (владелец 13.10). Заявку на машину ведёт
  // менеджер: ответить на неё из кабинета нельзя, и сюда она не попадает.
  transfer: [
    'Заявки на машину целиком подтверждает с вами менеджер Ведара — отвечать на них здесь не нужно; сами заявки видны в «Клиентах».',
  ],
  guide: [
    'Назначение на бронь в команде оператора подтверждать не нужно — оно сразу в расписании.',
    // Ответ на отзыв о туре — дверь оператора (app/api/operator/reviews/[id]/reply).
    'Отзывы туристов о турах, которые вы продаёте сами, сюда не попадают: ответить на них из кабинета гида пока нельзя.',
  ],
  agent: ['У агента входящих пока нет: заявок и чата с туристами у роли ещё нет.'],
};

/** У каких ролей есть чат с туристами (виджет в кабинете) — им показываем непрочитанное. */
export const INBOX_CHAT_CATEGORIES: ReadonlySet<PartnerCategory> = new Set(['operator', 'guide']);

export const INBOX_KIND_LABELS: Readonly<Record<InboxKind, string>> = {
  operator_booking: 'Бронь тура',
  seat_request: 'Запрос мест',
  lead: 'Заявка на подбор',
  accommodation_booking: 'Бронь жилья',
  stay_request: 'Заявка на жильё',
  gear_rental: 'Заказ снаряжения',
  transfer_seat_booking: 'Места в машине',
  guide_invite: 'Приглашение в команду',
  guide_review: 'Отзыв без ответа',
  tour_review: 'Отзыв о туре без ответа',
  stay_review: 'Отзыв гостя без ответа',
};

export interface InboxAction {
  /** Раздел кабинета, где отвечают; `null` — отвечают прямо во «Входящих». */
  href: string | null;
  hint: string;
}

/**
 * Где ответить — по виду предмета, как у роли, которой этот вид принадлежит.
 * `null` — отдельного раздела нет: на запрос мест продавец отвечает кнопками
 * прямо во «Входящих» (components/crm/SeatRequestActions) или в сообщении о
 * запросе в MAX/Telegram. Контакты туриста открываются только после «есть
 * места» (решение 29.09).
 *
 * Не экспортируется намеренно: бронь и заявку продают и оператор, и гид, а
 * кабинеты у них разные. Читать — только через `inboxActionFor`.
 */
const ACTION_BY_KIND: Readonly<Record<InboxKind, InboxAction>> = {
  operator_booking: { href: ownerBookingsPath('operator'), hint: 'Подтвердить или отклонить в «Бронированиях»' },
  seat_request: { href: null, hint: 'Ответить во «Входящих» кабинета или в сообщении о запросе (MAX или Telegram), срок — 2 часа' },
  lead: { href: ownerLeadsPath('operator'), hint: 'Ответить в «AI Заявках»' },
  accommodation_booking: { href: '/hub/stay/bookings', hint: 'Подтвердить или отклонить в «Бронях»' },
  // Кабинета у хозяина «через владельца» может не быть вовсе (у «Кутхи» его
  // нет): ответ — кнопкой «Ответить гостю» под заявкой в MAX или звонком.
  stay_request: {
    href: null,
    hint: 'Ответить кнопкой «Ответить гостю» под заявкой в MAX или позвонить по телефону из заявки; звонок запишите словами: «запиши звонок Анне»',
  },
  gear_rental: { href: '/hub/gear/rentals', hint: 'Подтвердить или отклонить в «Арендах»' },
  transfer_seat_booking: { href: '/hub/carrier', hint: 'Ответить в «Кабинете», раздел «Запросы мест»' },
  guide_invite: { href: '/hub/guide', hint: 'Принять или отклонить в «Обзоре»' },
  guide_review: { href: '/hub/guide/reviews', hint: 'Ответить в «Отзывах»' },
  tour_review: { href: '/hub/operator/reviews', hint: 'Ответить в «Отзывах»' },
  stay_review: { href: '/hub/stay/reviews', hint: 'Ответить в «Отзывах»' },
};

/**
 * Где отвечает гид на то, что продаёт сам: брони и заявки его туров — в
 * разделе «Свои туры» (то же правило, что у личных сообщений о брони,
 * lib/partners/cabinet-links). Кабинет оператора гида не пустит.
 */
const GUIDE_ACTION: Readonly<Partial<Record<InboxKind, InboxAction>>> = {
  operator_booking: { href: ownerBookingsPath('guide'), hint: 'Подтвердить или отклонить в разделе «Свои туры»' },
  lead: { href: ownerLeadsPath('guide'), hint: 'Отметить ответ в разделе «Свои туры»: связались, договорились или отказ' },
};

/**
 * Где роли ответить на предмет этого вида — экран «Входящих», инструмент
 * crm_inbox (MCP и помощник в чате) читают одно это правило.
 */
export function inboxActionFor(category: PartnerCategory, kind: InboxKind): InboxAction {
  return (category === 'guide' ? GUIDE_ACTION[kind] : undefined) ?? ACTION_BY_KIND[kind];
}

/**
 * Время первого ответа считается по просьбам клиента, где ответ ждут: брони,
 * заявки, приглашение. Отзыв без ответа во «Входящих» есть, но в медиану не
 * идёт: на отзыв отвечают не «быстро», а по делу.
 */
export const RESPONSE_METRIC_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>([
  'operator_booking', 'seat_request', 'lead', 'accommodation_booking', 'stay_request',
  'gear_rental', 'transfer_seat_booking', 'guide_invite',
]);

/** Окно медианы и порог: меньше пяти ответов — «мало данных», а не число. */
export const RESPONSE_WINDOW_DAYS = 7;
export const RESPONSE_MIN_SAMPLE = 5;
/** Отзывы старше этого во «Входящих» не держатся — это уже не «ждёт ответа». */
export const REVIEW_WINDOW_DAYS = 30;
/** Предмет ждёт дольше — на экране он отмечен как просроченный (урок Tripster: 2 часа). */
export const INBOX_SLOW_MINUTES = 120;
