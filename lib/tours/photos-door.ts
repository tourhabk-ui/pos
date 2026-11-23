/**
 * Снимки и точка сбора тура от ручных кронов — через дверь правки.
 *
 * До 23.11 `POST /api/cron/tour-photos` и `POST /api/cron/tour-pickup` писали
 * в живую строку тура своим UPDATE. Слово владельца 23.11: «Автоматы (кроны
 * описаний и фото, импортёры) пишут в туры только через очередь проверки,
 * своих обходных путей у них нет».
 *
 * Правило то же, что у владельца (lib/tours/tour-change): тур на сайте —
 * правка ложится черновиком на проверку; тур, которого туристы не видят и
 * который проверки не ждёт, — запись в строку. Считать «что уже есть» обе
 * двери обязаны по витрине вместе с правкой на проверке: иначе второй прогон
 * потерял бы снимки первого, ещё не одобренные.
 */
import { transaction } from '@/lib/database';
import { proposeTourChange, readTourForAutomaton, type AutomatonTourChange } from '@/lib/tours/tour-change';

/** Чем кончилась попытка: слова одни у обеих дверей. */
export type AutomatonWriteStatus =
  /** Тур на сайте: правка ждёт проверки администратора. */
  | 'staged'
  /** Тура на сайте нет и проверки он не ждёт: записано в строку. */
  | 'written'
  /** Сухой прогон: что случилось бы. */
  | 'would_stage' | 'would_write'
  /** Владелец уже отправил это поле на проверку: автомат его не перебивает. */
  | 'skipped_owner_pending'
  /** Менять нечего: то же самое уже стоит — на витрине или в правке на проверке. */
  | 'nothing_new'
  | 'not_found';

function statusOf(change: AutomatonTourChange): AutomatonWriteStatus {
  if (change.outcome === 'pending') return 'staged';
  if (change.outcome === 'written') return 'written';
  if (change.outcome === 'kept_owner') return 'skipped_owner_pending';
  if (change.outcome === 'not_found') return 'not_found';
  return 'nothing_new';
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.trim().length > 0) : [];
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Попал бы черновик на проверку или запись ушла бы в строку — правило двери. */
function wouldBe(published: boolean, hasDraft: boolean): 'would_stage' | 'would_write' {
  return published || hasDraft ? 'would_stage' : 'would_write';
}

export interface PhotosResult {
  status: AutomatonWriteStatus;
  title: string | null;
  /** Снимки до правки: витрина плюс правка на проверке. Это и откат. */
  was: string[];
  now: string[];
  added: number;
  alreadyPresent: number;
}

/** Приписать туру снимки. Дубли не добавляются: повтор прогона ничего не меняет. */
export async function proposeTourPhotos(
  tourId: string,
  add: readonly string[],
  opts: { dryRun: boolean },
): Promise<PhotosResult> {
  return transaction(async (client) => {
    const tour = await readTourForAutomaton(client, tourId);
    if (!tour) return { status: 'not_found', title: null, was: [], now: [], added: 0, alreadyPresent: 0 };
    const was = strings(tour.effective.photos);
    const fresh = add.filter((p, i) => !was.includes(p) && add.indexOf(p) === i);
    const now = [...was, ...fresh];
    const base = { title: text(tour.effective.title), was, now, added: fresh.length, alreadyPresent: add.length - fresh.length };
    if (fresh.length === 0) return { ...base, status: 'nothing_new' };
    if (tour.ownerPending.includes('photos')) return { ...base, now: was, added: 0, status: 'skipped_owner_pending' };
    if (opts.dryRun) return { ...base, status: wouldBe(tour.published, tour.hasDraft) };
    const change = await proposeTourChange(client, { tourId, source: 'tour-photos', input: { photos: now }, tour });
    return { ...base, status: statusOf(change) };
  });
}

export interface PickupResult {
  status: AutomatonWriteStatus;
  title: string | null;
  /** Точка сбора до правки: витрина плюс правка на проверке. Это и откат; null — было пусто. */
  was: string | null;
  now: string;
}

/** Записать туру точку сбора (прежнее поле `meeting_point`). */
export async function proposeTourPickup(
  tourId: string,
  pickup: string,
  opts: { dryRun: boolean },
): Promise<PickupResult> {
  return transaction(async (client) => {
    const tour = await readTourForAutomaton(client, tourId);
    if (!tour) return { status: 'not_found', title: null, was: null, now: pickup };
    const was = text(tour.effective.meeting_point);
    const base = { title: text(tour.effective.title), was, now: pickup };
    if (was === pickup) return { ...base, status: 'nothing_new' };
    if (tour.ownerPending.includes('meeting_point')) return { ...base, status: 'skipped_owner_pending' };
    if (opts.dryRun) return { ...base, status: wouldBe(tour.published, tour.hasDraft) };
    const change = await proposeTourChange(client, { tourId, source: 'tour-pickup', input: { meeting_point: pickup }, tour });
    return { ...base, status: statusOf(change) };
  });
}
