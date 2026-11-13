/**
 * lib/requests/tour-date-question.ts — вопрос оператору с формы брони сайта:
 * «ходите ли вы в этот день?» (план «после отказа», этап 6, срез б).
 *
 * Дату тура в календаре закрыл Ведар по описанию тура (миграции 1421, 1435),
 * оператор её не закрывал. Бронь на такую дату отвечает отказом
 * `DATE_CLOSED_BY_PLATFORM` со словами «спросите оператора» — а спросить с
 * сайта было нечем. ИИ-агент с 6а отправляет на такую дату заявку-вопрос
 * (`create_booking_request`); здесь — та же заявка с формы сайта: тот же
 * префикс комментария (повтор узнаётся между дверями), та же строка оператору
 * (`PLATFORM_CLOSED_LEAD_NOTE`), та же отметка `date_closed_by` в источнике.
 *
 * Вопрос уходит ТОЛЬКО на дату, закрытую Ведаром. Дату закрыл оператор, места
 * разобраны, дата открыта, признак не прочитался — заявки нет, и исход назван
 * словом, а не общим отказом (§4.0).
 *
 * Это заявка, не бронь: места не закрепляются. Имя и телефон получает оператор
 * тура — тот же адресат, что у брони; согласие человек дал галочкой формы.
 *
 * Сторожа: tests/unit/tour-date-question.test.ts (сервис и дверь — вызовом),
 * tests/integration/tour-dates-open.pg.test.ts (сцена «вопрос оператору с сайта»).
 */
import { pool } from '@/lib/db-pool';
import { isRealDate, kamchatkaToday } from '@/lib/seat-requests/core';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { isClosedByPlatform } from '@/lib/tours/date-closure';
import { PLATFORM_CLOSED_LEAD_NOTE } from '@/lib/mcp/booking-closed-date';
import { createLeadDetailed, findRecentLeadByCommentPrefix } from '@/lib/leads/create';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';

/** Префикс комментария заявки на тур на дату — один у MCP и у формы сайта: по нему узнаётся повтор. */
export function tourRequestPrefix(tourTitle: string, tourId: number | string, date: string): string {
  return `[Заявка на бронь] Тур "${tourTitle}" (ID${tourId}), дата ${date},`;
}

/** Комментарий заявки-вопроса: что за тур и дата, кто закрыл дату и что нужно от оператора, слова человека. */
export function dateQuestionComment(a: {
  tourTitle: string; tourId: number | string; date: string; participants: number; comment?: string | null;
}): string {
  return `${tourRequestPrefix(a.tourTitle, a.tourId, a.date)} участников ${a.participants}.`
    + PLATFORM_CLOSED_LEAD_NOTE
    + (a.comment ? ` ${a.comment}` : '');
}

export const TOUR_FOR_QUESTION_SQL = `
  SELECT ot.id::text AS id, ot.title, ot.operator_id::text AS operator_id, p.name AS operator_name
    FROM operator_tours ot
    LEFT JOIN partners p ON p.id = ot.operator_id
   WHERE ot.id = $1::bigint AND ${publicTourSql('ot')}`;

export interface DateQuestionInput {
  tourId: number;
  date: string;
  participants: number;
  name: string;
  /** Уже нормализованный телефон. */
  phone: string;
  comment?: string | null;
  /** Запись согласия человека — без неё заявки нет. */
  consent: PdConsentRecord;
  isSelf?: boolean;
  sourceUrl?: string;
}

export type DateQuestionOutcome =
  /** Заявка-вопрос записана (или узнан повтор — `created: false`). */
  | { state: 'sent'; leadId: string; created: boolean; tourTitle: string; operatorId: string | null; operatorName: string | null }
  | { state: 'bad_date' }
  | { state: 'past' }
  | { state: 'no_tour' }
  /** Дату Ведар не закрывал (открыта, занята, закрыта оператором, строки нет): вопрос этой дверью не задаётся. */
  | { state: 'not_platform_closed' }
  /** Тур или признак не прочитались — «не знаю», а не «не закрывал». */
  | { state: 'unknown' }
  | { state: 'failed' };

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

export interface DateQuestionDeps {
  query?: Query;
  closedByPlatform?: (tourId: number | string, date: string) => Promise<boolean | null>;
  findRecent?: typeof findRecentLeadByCommentPrefix;
  createLead?: typeof createLeadDetailed;
  today?: () => string;
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'нет SQLSTATE';
}

/**
 * Отправить оператору вопрос о дате, закрытой Ведаром. Порядок проверок —
 * от дешёвых к дорогим; запись — только после всех.
 */
export async function askOperatorAboutDate(input: DateQuestionInput, deps: DateQuestionDeps = {}): Promise<DateQuestionOutcome> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  const today = (deps.today ?? kamchatkaToday)();
  if (!isRealDate(input.date)) return { state: 'bad_date' };
  if (input.date < today) return { state: 'past' };

  let tour: { id: string; title: string; operator_id: string | null; operator_name: string | null } | undefined;
  try {
    ({ rows: [tour] } = await q(TOUR_FOR_QUESTION_SQL, [String(input.tourId)]) as { rows: Array<typeof tour> });
  } catch (err) {
    console.error(`[tour-date-question] тур ${input.tourId} не прочитан, SQLSTATE`, codeOf(err));
    return { state: 'unknown' };
  }
  if (!tour) return { state: 'no_tour' };

  const closed = await (deps.closedByPlatform ?? isClosedByPlatform)(tour.id, input.date);
  if (closed === null) return { state: 'unknown' };
  if (closed !== true) return { state: 'not_platform_closed' };

  const prefix = tourRequestPrefix(tour.title, tour.id, input.date);
  const existing = await (deps.findRecent ?? findRecentLeadByCommentPrefix)(input.phone, prefix);
  if (existing) {
    return { state: 'sent', leadId: existing, created: false, tourTitle: tour.title, operatorId: tour.operator_id, operatorName: tour.operator_name };
  }
  const saved = await (deps.createLead ?? createLeadDetailed)({
    name: input.name,
    phone: input.phone,
    comment: dateQuestionComment({
      tourTitle: tour.title, tourId: tour.id, date: input.date, participants: input.participants, comment: input.comment,
    }),
    route_title: tour.title,
    operator_id: tour.operator_id ?? undefined,
    source_url: input.sourceUrl,
    source_data: {
      source: 'tour_page', form: 'tour-date-question',
      tour_id: tour.id, date: input.date, participants: input.participants,
      // Дату закрыл Ведар, не оператор: заявка — вопрос «ходите ли в этот день».
      date_closed_by: 'platform',
    },
    pd_consent: input.consent,
    is_self: input.isSelf === true,
  });
  if (!saved) return { state: 'failed' };
  return {
    state: 'sent', leadId: saved.id, created: saved.created,
    tourTitle: tour.title, operatorId: tour.operator_id, operatorName: tour.operator_name,
  };
}

/** Слова человеку по исходу, когда заявки нет. `null` — заявка отправлена. */
export function dateQuestionRefusal(o: DateQuestionOutcome): { status: number; error: string; field?: string } | null {
  switch (o.state) {
    case 'sent': return null;
    case 'bad_date': return { status: 400, error: 'Такой даты нет в календаре — проверьте дату.', field: 'date' };
    case 'past': return { status: 422, error: 'Эта дата уже прошла — выберите другую.', field: 'date' };
    case 'no_tour': return { status: 404, error: 'Такого тура на Ведаре нет.' };
    case 'not_platform_closed':
      return { status: 409, error: 'Эту дату Ведар не закрывал — такой вопрос здесь не отправляется. Нажмите «Оставить заявку» ещё раз: форма скажет, что с датой сейчас.' };
    case 'unknown':
      return { status: 503, error: 'Не удалось проверить дату — вопрос не отправлен. Попробуйте позже или свяжитесь с оператором напрямую.' };
    case 'failed':
      return { status: 503, error: 'Не удалось отправить вопрос — попробуйте позже или свяжитесь с оператором напрямую.' };
  }
}

/** Что сказать человеку после отправки: это вопрос, не бронь; где ответ — зависит от того, выдана ли страница заявки. */
export function dateQuestionSentText(hasPage: boolean): string {
  return 'Вопрос отправлен оператору: ходит ли он в этот день. Это не бронь — места не закреплены. '
    + (hasPage
      ? 'Ответ оператора появится на странице заявки.'
      : 'Страница заявки не выдалась: ответ оператора на сайте не появится — у него есть телефон, который вы оставили.');
}
