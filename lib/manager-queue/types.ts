/**
 * Типы очереди менеджера (этап 3б). Модуль без базы и без серверных импортов:
 * его читает экран очереди ('use client') и слова для него. Серверный модуль
 * (lib/manager-queue/queue) тянет базу и правило вида заявки — в клиентский
 * граф ему нельзя даже типом: сторожа графа идут и по `import type`.
 */
export const QUEUE_KINDS = ['answer_notice', 'vehicle_decline', 'stay_busy'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUM_RE = /^[0-9]{1,18}$/;

/** Номер случая по форме его рода: строка журнала и сообщения — число, заявка на жильё — uuid. */
export function isQueueSubjectId(kind: QueueKind, id: string): boolean {
  return kind === 'stay_busy' ? UUID_RE.test(id) : NUM_RE.test(id);
}

export interface QueueTake { at: string; via: string; by: string | null }

export interface QueueBase {
  id: string;
  /** Когда случилось: отказ не дошёл / партнёр ответил. ISO. */
  happened_at: string;
  partner_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  take: QueueTake | null;
}
export interface NoticeItem extends QueueBase {
  kind: 'answer_notice';
  lead_id: string;
  lead_status: string | null;
  answer: string;
  decline_reason: string | null;
  /** Куда ушло письмо менеджеру о недоставке: max, telegram-stub, none; null — ещё не отправлялось. */
  manager_channel: string | null;
  tour_title: string | null;
  date: string | null;
  people: number | null;
  /** Другие компании, ответившие Ведару «Беру» на дату этой заявки (этап 4б); пусто — таких ответов нет. */
  takes: string[];
}
export interface VehicleItem extends QueueBase {
  kind: 'vehicle_decline';
  lead_id: string;
  lead_status: string | null;
  vehicle_kind: 'charter' | 'car_rental';
  /** У проката — машина, у заявки на машину — направление словами заказчика. */
  vehicle_title: string | null;
  date_from: string | null;
  date_to: string | null;
  /** Что стало с сообщением заказчику об отказе; null — сообщения по этому ответу нет. */
  notice_state: 'pending' | 'delivered' | 'undelivered' | 'skipped' | null;
}
export interface StayItem extends QueueBase {
  kind: 'stay_busy';
  stay_request_id: string;
  accommodation_name: string;
  check_in: string;
  check_out: string;
  guests: number;
}
export type QueueItem = NoticeItem | VehicleItem | StayItem;

/**
 * Три исхода чтения источника: случаи есть, никого нет (пустой список) либо
 * источник не прочитался. `more` — разобраны только последние
 * QUEUE_SOURCE_LIMIT строк источника, более ранние в список не попали.
 */
export type QueueSource<T> = { state: 'ok'; items: T[]; more: boolean } | { state: 'failed' };

export interface ManagerQueue {
  since: string;
  answer_notice: QueueSource<NoticeItem>;
  vehicle_decline: QueueSource<VehicleItem>;
  stay_busy: QueueSource<StayItem>;
}
