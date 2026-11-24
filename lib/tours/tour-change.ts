/**
 * Правка тура владельцем — одна дверь (план готовности 23.11, этап 4).
 *
 * До этого дня кабинет оператора, кабинет гида и чат гида писали тур прямо
 * в живую строку: правка цены или описания выходила на витрину в ту же
 * секунду, а публикацию включала одна галочка. Теперь у владельца один путь:
 *
 *   - содержание (название, тексты, программа, состав, условия отмены, точка
 *     сбора, цена, снимки, а с 23.11 — сложность, длительность, место и
 *     сезон) — черновиком на проверку; на витрине остаётся последняя
 *     одобренная версия;
 *   - остальное (скрыть и показать тур, снять с публикации, даты, число
 *     мест, расписание) — сразу;
 *   - публикация — просьба: `is_published = TRUE` ставит только одобрение.
 *
 * Тур, который ещё не на витрине и не ждёт проверки, владелец правит
 * свободно: туристы его не видят, проверять нечего. Как только он попросил
 * публикацию, содержание замирает и дальше идёт черновиком — администратор
 * одобряет то, что видел.
 *
 * Администратор (ownerId = null) пишет напрямую: он и есть проверка.
 *
 * Автомат платформы (`source`) идёт этой же дверью и по тому же правилу
 * (слово владельца 23.11: «своих обходных путей у них нет»). Его поля в
 * черновике помечены его именем, поле владельца на проверке он не
 * перебивает, публикацию не просит. Тур для автомата читает
 * `readTourForAutomaton` — под тем же замком.
 *
 * Транзакцию даёт вызывающий. Пинг IndexNow — после COMMIT и только когда
 * что-то записано в живую строку.
 */
import type { PoolClient } from 'pg';
import { assertLiveMainPlace } from '@/lib/tours/main-place';
import { writeTourPatch, type TourPatchInput, type TourWriteResult } from '@/lib/tours/tour-write';
import { contentDiff, effectiveContent, pendingNotice, splitTourInput, type ModeratedTourColumn } from '@/lib/tours/moderation';
import { LIVE_CONTENT_COLUMNS, lockPendingTourEdit, stageTourEdit } from '@/lib/tours/moderation-store';
import { cleanPatch, fieldsOf } from '@/lib/tours/moderation-read';
import { cleanProposedBy, splitByAuthor, type TourAutomaton } from '@/lib/tours/automaton';

export interface PendingSummary {
  editId: string;
  /** Поля, которые ждут проверки (весь черновик, не только эта правка). */
  fields: ModeratedTourColumn[];
  wantsPublish: boolean;
  /** Что сказать владельцу. */
  notice: string;
  /** Поля автомата, которые не легли: владелец уже отправил их на проверку. */
  keptOwner: ModeratedTourColumn[];
}

export type TourChange =
  /** Всё записано в живую строку; на проверку ничего не ушло. */
  | { outcome: 'written'; row: TourWriteResult; pending: null }
  /** Содержание ушло на проверку; `row` — если заодно записано что-то «сразу». */
  | { outcome: 'pending'; row: TourWriteResult | null; pending: PendingSummary }
  /**
   * Прислано то же, что уже стоит: менять нечего, и это не ошибка. Форма
   * шлёт себя целиком при каждом сохранении — «Сохранить» без правок обязано
   * отвечать успехом, как и до очереди.
   */
  | { outcome: 'unchanged' }
  /** Тура нет, он удалён или не этой карточки. */
  | { outcome: 'not_found' }
  /** В запросе нет ни одного поля тура. */
  | { outcome: 'empty' };

/**
 * Исход правки автомата. Сверх исходов человека — один: автомат не записал
 * ничего, потому что все его поля владелец уже отправил на проверку.
 * Черновик при этом не тронут.
 */
export type AutomatonTourChange = TourChange | { outcome: 'kept_owner'; fields: ModeratedTourColumn[] };

interface LiveRow extends Record<string, unknown> {
  is_published: boolean | null;
  operator_id: string;
}

const LOCK_OWN_SQL = `SELECT ot.operator_id::text AS operator_id, ot.is_published, ${LIVE_CONTENT_COLUMNS}
     FROM operator_tours ot
    WHERE ot.id = $1::bigint AND ot.deleted_at IS NULL AND ot.operator_id = $2::uuid
    FOR UPDATE`;

interface ChangeOpts {
  tourId: bigint | string;
  /** `partners.id` владельца тура; null — администратор. */
  ownerId: string | null;
  /** Кто сохраняет (users.id) — в черновик; у чата может не быть. */
  userId: string | null;
  input: TourPatchInput;
  /** Строка тура до правки (для главного места). */
  current: Record<string, unknown>;
}

/** Правка человека: владелец тура или администратор. */
export async function saveTourChange(client: Pick<PoolClient, 'query'>, opts: ChangeOpts): Promise<TourChange> {
  const change = await changeTour(client, opts, null);
  // У человека такого исхода нет: «поле владельца» — он сам.
  return change.outcome === 'kept_owner' ? { outcome: 'unchanged' } : change;
}

/**
 * Правка автомата платформы — та же дверь и то же правило, что у владельца.
 * Тур автомат читает через `readTourForAutomaton` в этой же транзакции и
 * передаёт сюда: карточка тура берётся из прочитанного, а не из параметра
 * вызывающего.
 */
export async function proposeTourChange(
  client: Pick<PoolClient, 'query'>,
  opts: { tourId: bigint | string; source: TourAutomaton; input: TourPatchInput; tour: AutomatonTourView },
): Promise<AutomatonTourChange> {
  return changeTour(
    client,
    { tourId: opts.tourId, ownerId: opts.tour.operatorId, userId: null, input: opts.input, current: opts.tour.live },
    opts.source,
  );
}

async function changeTour(
  client: Pick<PoolClient, 'query'>,
  opts: ChangeOpts,
  source: TourAutomaton | null,
): Promise<AutomatonTourChange> {
  const { tourId, ownerId, input, current } = opts;

  if (ownerId === null) {
    const w = await writeTourPatch(client, { tourId, ownerId: null, input, current });
    return w.outcome === 'written' ? { outcome: 'written', row: w.row, pending: null } : w;
  }

  // Живая строка читается здесь же и под замком: что считать «уже на
  // витрине», решает база, а не то, что вызывающий прочитал раньше.
  const live = (await client.query<LiveRow>(LOCK_OWN_SQL, [String(tourId), ownerId])).rows[0];
  if (!live) return { outcome: 'not_found' };

  const { content, immediate, wantsPublish } = splitTourInput(input as Record<string, unknown>);
  const published = live.is_published === true;
  const pendingBefore = await lockPendingTourEdit(client, tourId);
  // Публикацию просит только человек: автомат тур на витрину не выводит.
  const asksPublish = wantsPublish && !published && source === null;

  // Не на витрине и проверки не ждёт: содержание пишется прямо в строку.
  const direct = !published && pendingBefore === null;
  const now = { ...immediate, ...(direct ? content : {}) } as TourPatchInput;

  let row: TourWriteResult | null = null;
  if (Object.keys(now).length > 0) {
    const w = await writeTourPatch(client, { tourId, ownerId, input: now, current });
    if (w.outcome === 'not_found') return w;
    if (w.outcome === 'written') row = w.row;
  }

  // Что ещё нужно проверить: содержание опубликованного или замершего тура
  // и сама просьба о публикации.
  const toStage = direct ? {} : content;
  const written: AutomatonTourChange = row
    ? { outcome: 'written', row, pending: null }
    // Содержание прислано, но оно равно витрине — «без изменений»; не прислано
    // ничего, что можно записать, — «нечего сохранять», как было у роута.
    : (Object.keys(content).length > 0 ? { outcome: 'unchanged' } : { outcome: 'empty' });
  // В этой правке нет ни содержания, ни просьбы: черновик, если он есть,
  // не трогается. Скрыть тур или поменять даты — не правка на проверку.
  if (Object.keys(toStage).length === 0 && !asksPublish) return written;
  // Содержание прислано, но оно равно витрине, и черновика нет (форма шлёт
  // себя целиком при каждом сохранении): проверять нечего.
  if (pendingBefore === null && !asksPublish && Object.keys(contentDiff(live, toStage)).length === 0) return written;

  // Главное место проверяется при отправке на проверку, а не только при
  // одобрении: иначе владелец узнал бы, что место скрыто или слито, лишь из
  // отказа администратора. Не живое — MainPlaceRejected, ничего не записано.
  const stagedPlace = (toStage as Record<string, unknown>).main_place_id;
  if (typeof stagedPlace === 'string' && stagedPlace !== (live.main_place_id ?? null)) {
    await assertLiveMainPlace(client, stagedPlace);
  }

  // Просьба о публикации вместе с прямой правкой: администратор должен
  // увидеть уже записанное содержание — сверяем с ним, а не со старой строкой.
  const liveForStage: Record<string, unknown> = direct ? { ...live, ...content } : live;
  const staged = await stageTourEdit(client, {
    tourId,
    partnerId: ownerId,
    userId: opts.userId,
    live: liveForStage,
    content: toStage,
    wantsPublish: asksPublish,
    pending: pendingBefore,
    source,
  });
  if (staged.outcome === 'none') return written;
  if (staged.outcome === 'kept') return row ? written : { outcome: 'kept_owner', fields: staged.keptOwner };
  return {
    outcome: 'pending',
    row,
    pending: {
      editId: staged.editId,
      fields: staged.fields,
      wantsPublish: staged.wantsPublish,
      notice: pendingNotice(staged.fields, staged.wantsPublish, published),
      keptOwner: staged.keptOwner,
    },
  };
}

// ─── Тур глазами автомата ─────────────────────────────────────────────────────

export interface AutomatonTourView {
  /** Карточка тура (`partners.id`): с ней автомат идёт в `saveTourChange`. */
  operatorId: string;
  published: boolean;
  /** Что на витрине сейчас. */
  live: Record<string, unknown>;
  /** Витрина плюс правка на проверке: то, что выйдет после одобрения. */
  effective: Record<ModeratedTourColumn, unknown>;
  /** Поля, которые владелец уже отправил на проверку: автомат их не трогает. */
  ownerPending: ModeratedTourColumn[];
}

const LOCK_ANY_SQL = `SELECT ot.operator_id::text AS operator_id, ot.is_published, ${LIVE_CONTENT_COLUMNS}
     FROM operator_tours ot
    WHERE ot.id = $1::bigint AND ot.deleted_at IS NULL
    FOR UPDATE`;

/**
 * Тур для автомата: живая строка и черновик под замком, в транзакции
 * вызывающего. Решать, что предложить, автомат обязан по `effective`: по
 * одной живой строке он предложил бы то, что владелец уже дописал и отправил
 * на проверку. `null` — тура нет или он удалён.
 */
export async function readTourForAutomaton(
  client: Pick<PoolClient, 'query'>,
  tourId: bigint | string,
): Promise<AutomatonTourView | null> {
  const live = (await client.query<LiveRow>(LOCK_ANY_SQL, [String(tourId)])).rows[0];
  if (!live) return null;
  const pending = await lockPendingTourEdit(client, tourId);
  const patch = cleanPatch(pending?.patch);
  return {
    operatorId: live.operator_id,
    published: live.is_published === true,
    live,
    effective: effectiveContent(live, patch),
    ownerPending: splitByAuthor(fieldsOf(patch), cleanProposedBy(pending?.proposed_by)).owner,
  };
}
