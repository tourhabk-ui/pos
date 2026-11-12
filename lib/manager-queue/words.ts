/**
 * Слова очереди менеджера (этап 3б): что случилось и что известно о том,
 * узнал ли клиент. Модуль без базы и сети — его импортирует экран.
 *
 * Каждая строка говорит только записанное: «сообщено» — по исходу отправки,
 * «не дошло» — по нему же; о том, чего система не знает (прочитал ли гость
 * ответ хозяина), строки нет.
 */
import { DECLINE_REASON_LABEL, isDeclineReason } from '@/lib/requests/decline-reasons';
import type { NoticeItem, QueueItem, QueueKind, QueueTake, VehicleItem } from '@/lib/manager-queue/types';

export const QUEUE_SECTION: Record<QueueKind, { title: string; lead: string; empty: string }> = {
  answer_notice: {
    title: 'Отказ не дошёл до клиента',
    lead: 'Оператор или гид отказал, а сообщение об этом клиент не получил: ни его чат, ни ИИ-агент его не приняли. Позвонить и сказать.',
    empty: 'Недоставленных отказов нет.',
  },
  vehicle_decline: {
    title: 'Перевозчик или прокатчик не может',
    lead: 'Партнёр ответил «Не могу». Заказчику нужен другой перевозчик или другая машина.',
    empty: 'Отказов перевозчиков и прокатчиков нет.',
  },
  stay_busy: {
    title: 'Жильё занято',
    lead: 'Хозяин ответил «занято». Другого жилья гостю никто не предложил — позвонить и помочь с заменой.',
    empty: 'Ответов «занято» нет.',
  },
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 2026-11-05 → 05.11.2026; не дата — как есть. */
export function ruDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = DATE_RE.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function span(from: string | null, to: string | null): string | null {
  const [a, b] = [ruDate(from), ruDate(to)];
  if (a && b) return a === b ? a : `с ${a} по ${b}`;
  return a ?? b;
}

const partner = (name: string | null, fallback: string) => (name ? `«${name}»` : fallback);

function noticeAnswer(i: NoticeItem): string {
  if (i.answer === 'no_seats') return 'мест на эту дату нет';
  if (i.answer === 'other_date') return 'предложит другую дату';
  const reason = isDeclineReason(i.decline_reason) ? DECLINE_REASON_LABEL[i.decline_reason].toLowerCase() : 'причина не указана';
  return `отказ — ${reason}`;
}

const MANAGER_CHANNEL: Record<string, string> = {
  max: 'Письмо с телефоном ушло в рабочий чат MAX.',
  'telegram-stub': 'В MAX письмо не ушло; в Telegram — заглушка без телефона.',
  none: 'Письмо менеджеру пока не дошло — отправка повторяется.',
  // Письмо ждало повтора, пока заявка была занята другим (бронь, новая дата); теперь вид заявки снова этот отказ.
  not_needed: 'Письмо менеджеру не отправлялось.',
};

const NOTICE_STATE: Record<NonNullable<VehicleItem['notice_state']>, string> = {
  delivered: 'Заказчику об отказе сообщено.',
  undelivered: 'Сообщение об отказе до заказчика не дошло — позвонить.',
  pending: 'Сообщение заказчику ещё отправляется.',
  skipped: 'Сообщение заказчику не отправлялось.',
};

/** Что за заявка — одной строкой. */
export function queueSubjectLine(i: QueueItem): string {
  if (i.kind === 'answer_notice') {
    return [i.tour_title ? `Тур «${i.tour_title}»` : 'Тур', ruDate(i.date), i.people ? `${i.people} чел.` : null]
      .filter(Boolean).join(', ');
  }
  if (i.kind === 'vehicle_decline') {
    const what = i.vehicle_kind === 'charter' ? 'Машина под заказ' : 'Прокат';
    return [i.vehicle_title ? `${what}: ${i.vehicle_title}` : what, span(i.date_from, i.date_to)].filter(Boolean).join(', ');
  }
  return [`Жильё «${i.accommodation_name}»`, span(i.check_in, i.check_out), `гостей: ${i.guests}`].filter(Boolean).join(', ');
}

/**
 * Другие компании, ответившие Ведару «Беру» на дату заявки (этап 4б). Это их
 * слово, не бронь: заявку клиент оставляет им сам — так и сказано тому, кто
 * будет звонить.
 */
export function takesLine(takes: readonly string[] | null | undefined): string | null {
  // Ответ старой сборки сервера поля не несёт — экран от этого не падает.
  if (!takes || takes.length === 0) return null;
  const names = takes.map((n) => `«${n}»`).join(', ');
  return `На вопрос Ведара «возьмёте на эту дату?» ответили «Беру»: ${names}. Это слово ${takes.length === 1 ? 'компании' : 'компаний'}, не бронь — заявку клиент оставляет сам.`;
}

/** Что ответил партнёр и что известно о сообщении клиенту. */
export function queueStateLines(i: QueueItem): string[] {
  if (i.kind === 'answer_notice') {
    return [
      `${partner(i.partner_name, 'Оператор')}: ${noticeAnswer(i)}.`,
      'Сообщение об этом до клиента не дошло.',
      i.manager_channel ? MANAGER_CHANNEL[i.manager_channel] ?? null : 'Письмо менеджеру ещё не отправлялось.',
      takesLine(i.takes),
    ].filter((x): x is string => typeof x === 'string');
  }
  if (i.kind === 'vehicle_decline') {
    const who = i.vehicle_kind === 'charter' ? 'Перевозчик' : 'Прокатчик';
    return [
      `${who} ${partner(i.partner_name, '')}`.trim() + ' ответил «Не могу».',
      i.notice_state ? NOTICE_STATE[i.notice_state] : 'Сообщения заказчику по этому ответу нет.',
    ];
  }
  return [`Хозяин ${partner(i.partner_name, '')}`.trim() + ' ответил «занято».'];
}

/** «Взял Иван 12.11 в 21:05» — время по Камчатке. */
export function takeLine(t: QueueTake): string {
  const when = new Date(t.at);
  const at = Number.isNaN(when.getTime()) ? null : kamchatkaStamp(when);
  return [`Взял: ${t.by ?? 'администратор (имя не записано)'}`, at, t.via === 'max' ? 'в MAX' : null].filter(Boolean).join(', ');
}

/** 12.11, 21:05 — по Камчатке (UTC+12, без перехода на летнее время). */
export function kamchatkaStamp(d: Date): string {
  const k = new Date(d.getTime() + 12 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(k.getUTCDate())}.${p(k.getUTCMonth() + 1)}, ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

/**
 * Номер заявки — тот же, что стоит в сообщении менеджеру в MAX и Telegram:
 * по нему случай из очереди сверяют с письмом и находят в «CRM — Лиды».
 * Страницы одной заявки в админке нет, поэтому ссылки здесь нет.
 */
export function queueRequestId(i: QueueItem): string {
  return i.kind === 'stay_busy' ? i.stay_request_id : i.lead_id;
}
