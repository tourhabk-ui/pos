/**
 * Собранное описание тура — через дверь правки, а не прямой записью.
 *
 * До 23.11 `POST /api/cron/tour-describe` писал описание в живую строку
 * своим UPDATE: текст выходил на сайт без проверки. Слово владельца 23.11:
 * «Автоматы (кроны описаний и фото, импортёры) пишут в туры только через
 * очередь проверки, своих обходных путей у них нет».
 *
 * Правило то же, что у владельца (lib/tours/tour-change): тур на сайте —
 * описание ложится черновиком на проверку, на витрине прежний текст; тур,
 * которого туристы не видят и который проверки не ждёт, — запись в строку.
 */
import { transaction } from '@/lib/database';
import { MIN_DESCRIPTION_CHARS } from '@/lib/tours/describe';
import { proposeTourChange, readTourForAutomaton } from '@/lib/tours/tour-change';

export type DescribeOutcome =
  /** Тур на сайте: описание ждёт проверки администратора. */
  | 'staged'
  /** Тура на сайте нет и проверки он не ждёт: описание записано в строку. */
  | 'written'
  /** Владелец уже отправил своё описание на проверку: автомат его не перебивает. */
  | 'skipped_owner_pending'
  /** Описание уже не короткое — на витрине или в правке на проверке. */
  | 'skipped_already_long'
  /** Собранный текст совпал с тем, что стоит. */
  | 'unchanged'
  /** Тура нет или он удалён. */
  | 'not_found';

/**
 * Предложить туру собранное описание. Условие «описание короткое» проверяется
 * здесь же, под замком строки: между переписью и записью владелец мог
 * дописать текст сам — на витрине или в правке, которая ждёт проверки.
 */
export async function proposeTourDescription(tourId: string, text: string): Promise<DescribeOutcome> {
  return transaction(async (client) => {
    const tour = await readTourForAutomaton(client, tourId);
    if (!tour) return 'not_found';
    if (tour.ownerPending.includes('description')) return 'skipped_owner_pending';
    const now = typeof tour.effective.description === 'string' ? tour.effective.description : '';
    if (now.length >= MIN_DESCRIPTION_CHARS) return 'skipped_already_long';

    const change = await proposeTourChange(client, {
      tourId, source: 'tour-describe', input: { description: text }, tour,
    });
    if (change.outcome === 'pending') return 'staged';
    if (change.outcome === 'written') return 'written';
    if (change.outcome === 'kept_owner') return 'skipped_owner_pending';
    if (change.outcome === 'not_found') return 'not_found';
    return 'unchanged';
  });
}
