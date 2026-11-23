/**
 * Очереди партнёрского контура: типы и слова отчёта (план готовности 23.11,
 * этап 6). Чистый модуль без базы — его читает экран администратора
 * (клиентский код). Чтение чисел — lib/admin/partner-queues.ts.
 *
 * Число, которое прочитать не удалось, — 'unknown': это не ноль, и слова
 * отчёта говорят «не прочитано», а не «0».
 */

export type QueueCount = number | 'unknown';

export interface PartnerQueues {
  /** Заявки партнёров, ждущие одобрения; по ролям. */
  awaitingApproval: { total: QueueCount; byCategory: Array<{ category: string; count: number }> };
  /** На витрине, а MAX и Telegram не подключены: заявки до партнёра не дойдут. */
  storefrontNoChannel: QueueCount;
  /** Одобрены, но не на витрине и без канала: поставить на витрину их нельзя (этап 3b). */
  approvedNoChannel: QueueCount;
  /** Тестовые профили: на витрину не выходят. */
  testProfiles: QueueCount;
  /** Очередь проверки туров (этап 4): первый выклад и правки опубликованных. */
  tourEdits: { newTours: QueueCount; edits: QueueCount };
  /** Партнёры — стороны оферты без отметки о действующей редакции (этап 5). Не блокирует. */
  offerNotAccepted: QueueCount;
}


// ─── Слова отчёта ─────────────────────────────────────────────────────────────

export type QueueTone = 'calm' | 'attention' | 'unknown';

export interface QueueLine {
  key: 'awaiting' | 'storefront_no_channel' | 'approved_no_channel' | 'tour_new' | 'tour_edits' | 'offer' | 'test';
  label: string;
  /** Число словами: «3» или «не прочитано». */
  value: string;
  /** Что это значит и что делать — одной фразой. */
  hint: string;
  tone: QueueTone;
  href?: string;
}

const ROLE_WORDS: Record<string, string> = {
  operator: 'операторы', guide: 'гиды', transfer: 'перевозчики', stay: 'жильё', gear: 'снаряжение', cars: 'прокат автомобилей',
  agent: 'агенты', restaurant: 'рестораны', souvenir: 'сувениры',
};

const show = (n: QueueCount): string => (n === 'unknown' ? 'не прочитано' : String(n));

/** «Внимание» — когда число больше нуля; «не прочитано» — отдельный тон, не ноль. */
const tone = (n: QueueCount, attention: boolean): QueueTone => (n === 'unknown' ? 'unknown' : n > 0 && attention ? 'attention' : 'calm');

export function queueLines(q: PartnerQueues): QueueLine[] {
  const roles = q.awaitingApproval.byCategory
    .map((r) => `${ROLE_WORDS[r.category] ?? r.category} — ${r.count}`)
    .join(', ');
  return [
    {
      key: 'awaiting', label: 'Ждут одобрения', value: show(q.awaitingApproval.total),
      hint: roles ? `По ролям: ${roles}.` : 'Заявки партнёров на проверке.',
      tone: tone(q.awaitingApproval.total, true),
    },
    {
      key: 'storefront_no_channel', label: 'На витрине без канала', value: show(q.storefrontNoChannel),
      hint: 'Карточку видят туристы, а MAX и Telegram не подключены: заявка до партнёра не дойдёт.',
      tone: tone(q.storefrontNoChannel, true),
    },
    {
      key: 'approved_no_channel', label: 'Одобрены, ждут канала', value: show(q.approvedNoChannel),
      hint: 'На витрину такую карточку поставить нельзя, пока партнёр не подключит MAX или Telegram.',
      tone: tone(q.approvedNoChannel, true),
    },
    {
      key: 'tour_new', label: 'Новые туры на проверке', value: show(q.tourEdits.newTours),
      hint: 'Первый выклад тура на сайт ждёт решения.',
      tone: tone(q.tourEdits.newTours, true), href: '/hub/admin/moderation',
    },
    {
      key: 'tour_edits', label: 'Правки туров на проверке', value: show(q.tourEdits.edits),
      hint: 'На сайте пока прежняя версия тура.',
      tone: tone(q.tourEdits.edits, true), href: '/hub/admin/moderation',
    },
    {
      key: 'offer', label: 'Без отметки об оферте', value: show(q.offerNotAccepted),
      hint: 'Заведены до отметки на регистрации. Работе не мешает: партнёр принимает оферту в своём кабинете.',
      tone: tone(q.offerNotAccepted, false),
    },
    {
      key: 'test', label: 'Тестовые профили', value: show(q.testProfiles),
      hint: 'На витрину не выходят.',
      tone: tone(q.testProfiles, false),
    },
  ];
}
