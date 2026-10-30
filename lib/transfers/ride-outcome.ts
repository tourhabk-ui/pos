/**
 * «Поездка состоялась» / «Не состоялась» — ответ перевозчика на следующий
 * день после поездки по заявке на машину (#2862 этап B, 30.10). Чистые
 * функции: кнопки, разбор, срок, тексты. Запись и следствия — в
 * ride-outcome-flow.
 *
 * Payload `rc:y:<leadId>` / `rc:n:<leadId>` — та же форма, что у «Беру» /
 * «Не могу» (`rr:`, lib/rental/request-answer): короче лимитов MAX и
 * Telegram, партнёра и права в нём нет — их даёт привязанный чат.
 *
 * Зачем это: отзыв о перевозчике оставляет только тот, кто ехал, и право
 * даёт подтверждение поездки (§14, 1235). До 30.10 подтвердить мог один
 * менеджер Ведара; теперь — сам перевозчик, и под отзывом будет сказано,
 * что подтвердил он (род `charter_carrier`, 1353). «Состоялась» — слово
 * перевозчика о факте, не оценка; «не состоялась» — заявка закрывается.
 */

import { isLeadId, type ClientTold } from '@/lib/rental/request-answer';
import { escapeHtml } from '@/lib/text/escape-html';
import { CARRIER_REVIEW_INVITE_DAYS } from '@/lib/transfers/carrier-review-rules';

export type RideOutcome = 'held' | 'not_held';

/** Кнопки под вопросом о поездке. undefined — id не uuid, вебхук такую не разберёт. */
export function rideOutcomeButtons(leadId: string): Array<{ text: string; payload: string }> | undefined {
  if (!isLeadId(leadId)) return undefined;
  const id = leadId.toLowerCase();
  return [
    { text: 'Поездка состоялась', payload: `rc:y:${id}` },
    { text: 'Не состоялась', payload: `rc:n:${id}` },
  ];
}

export function isRideOutcomePayload(payload: string): boolean {
  return payload.startsWith('rc:');
}

export function parseRideOutcomePress(payload: string): { outcome: RideOutcome; leadId: string } | null {
  const m = /^rc:([yn]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(payload);
  if (!m) return null;
  return { outcome: m[1]!.toLowerCase() === 'y' ? 'held' : 'not_held', leadId: m[2]!.toLowerCase() };
}

/**
 * Поездка закончилась: последний день (дата возвращения, а без неё — дата
 * выезда) уже прошёл по Камчатке. Подтверждать поездку в день выезда рано —
 * она ещё идёт; вопрос задаётся с утра следующего дня. Даты не разобрать —
 * null («не знаю»), а не «можно».
 */
export function rideEnded(dateFrom: string | null, dateTo: string | null, today: string): boolean | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const last = dateTo && iso.test(dateTo) ? dateTo : dateFrom && iso.test(dateFrom) ? dateFrom : null;
  if (!last) return null;
  return last < today;
}

export type RideTell =
  | { kind: 'held'; clientTold: ClientTold; /** Ссылка выдана (null — не выдана: причина в `linkProblem`). */ linkIssued: boolean; linkProblem: string | null }
  | { kind: 'not_held' }
  | { kind: 'already'; outcome: RideOutcome }
  /** На заявку не было «Беру» — подтверждать поездку нечем. */
  | { kind: 'not_taken' }
  | { kind: 'not_yet'; lastDay: string | null }
  | { kind: 'not_yours' }
  | { kind: 'missing' }
  | { kind: 'unread' }
  | { kind: 'retry' }
  | { kind: 'unparsed' };

/** Строка перевозчику. HTML. Имени и телефона заказчика здесь нет. */
export function rideTellText(tell: RideTell): string {
  switch (tell.kind) {
    case 'held': {
      const link = tell.linkIssued
        ? tell.clientTold === true
          ? 'Заказчику отправлена ссылка на отзыв о вас.'
          : tell.clientTold === false
            ? 'Ссылку на отзыв заказчику отправить не удалось — её передаст менеджер Ведара.'
            : 'Ссылку на отзыв заказчику передаст менеджер Ведара.'
        : `Ссылка на отзыв не выдана: ${tell.linkProblem ?? 'причина не названа'}.`;
      return `<b>Записано:</b> поездка состоялась. ${link}`;
    }
    case 'not_held':
      return '<b>Записано:</b> поездка не состоялась. Заявка закрыта; менеджер Ведара это увидит.';
    case 'already':
      return tell.outcome === 'held'
        ? 'Исход уже записан: поездка состоялась. Второй раз не пишу.'
        : 'Исход уже записан: поездка не состоялась. Второй раз не пишу.';
    case 'not_taken':
      return 'На эту заявку не было ответа «Беру» — подтверждать поездку нечем. Ничего не записано.';
    case 'not_yet':
      return tell.lastDay
        ? `Поездка ещё не закончилась (последний день — ${escapeHtml(tell.lastDay)}): ответить можно со следующего дня. Ничего не записано.`
        : 'В заявке нет даты поездки — подтверждать нечего. Ничего не записано.';
    case 'not_yours':
      return 'Эта заявка не ваша. Ничего не записано.';
    case 'missing':
      return 'Заявку не нашёл. Ничего не записано.';
    case 'unread':
      return 'Не удалось прочитать заявку. Ничего не записано.';
    case 'retry':
      return 'Исход не записал: база не ответила. Нажмите кнопку ещё раз.';
    case 'unparsed':
      return 'Кнопка не распознана. Ничего не записано.';
  }
}

/** HTTP-статус исхода для двери сайта. */
export function rideTellStatus(tell: RideTell): number {
  switch (tell.kind) {
    case 'held':
    case 'not_held':
      return 200;
    case 'already':
      return 409;
    case 'not_taken':
    case 'not_yet':
      return 409;
    case 'missing':
      return 404;
    case 'not_yours':
      return 403;
    case 'unread':
    case 'retry':
      return 503;
    case 'unparsed':
      return 400;
  }
}

/** Заказчику в переписку заявки: ссылка на отзыв. Без разметки — текст идёт и на страницу. */
export function clientRideHeldText(partnerName: string, reviewUrl: string): string {
  const who = partnerName.trim() || 'Перевозчик';
  return `Перевозчик «${who}» подтвердил, что поездка состоялась. Если хотите, оставьте отзыв о перевозчике — его увидят другие туристы. Ссылка действует ${CARRIER_REVIEW_INVITE_DAYS} дней и годится на один отзыв: ${reviewUrl}`;
}

/** Менеджеру Ведара — факт без ПД заказчика. HTML. */
export function managerRideText(opts: {
  partnerName: string;
  leadId: string;
  outcome: RideOutcome;
  destination: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  /** Ссылка, которую заказчику отправить не удалось: передать её — дело менеджера. */
  forwardUrl: string | null;
}): string {
  const who = escapeHtml(opts.partnerName);
  const lines = [
    opts.outcome === 'held'
      ? `Перевозчик «${who}» подтвердил: поездка по заявке на машину <code>${escapeHtml(opts.leadId)}</code> состоялась.`
      : `Перевозчик «${who}» сообщил: поездка по заявке на машину <code>${escapeHtml(opts.leadId)}</code> не состоялась. Заявка закрыта.`,
  ];
  if (opts.destination) lines.push(`Направление: ${escapeHtml(opts.destination)}`);
  if (opts.dateFrom) lines.push(opts.dateTo ? `Даты: с ${escapeHtml(opts.dateFrom)} по ${escapeHtml(opts.dateTo)}` : `Дата выезда: ${escapeHtml(opts.dateFrom)}`);
  if (opts.forwardUrl) lines.push(`Ссылку на отзыв заказчику отправить не удалось — передайте сами: ${escapeHtml(opts.forwardUrl)}`);
  return lines.join('\n');
}
