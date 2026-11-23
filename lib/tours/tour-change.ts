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
 * Транзакцию даёт вызывающий. Пинг IndexNow — после COMMIT и только когда
 * что-то записано в живую строку.
 */
import type { PoolClient } from 'pg';
import { assertLiveMainPlace } from '@/lib/tours/main-place';
import { writeTourPatch, type TourPatchInput, type TourWriteResult } from '@/lib/tours/tour-write';
import { contentDiff, pendingNotice, splitTourInput, type ModeratedTourColumn } from '@/lib/tours/moderation';
import { LIVE_CONTENT_COLUMNS, lockPendingTourEdit, stageTourEdit } from '@/lib/tours/moderation-store';

export interface PendingSummary {
  editId: string;
  /** Поля, которые ждут проверки (весь черновик, не только эта правка). */
  fields: ModeratedTourColumn[];
  wantsPublish: boolean;
  /** Что сказать владельцу. */
  notice: string;
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

interface LiveRow extends Record<string, unknown> {
  is_published: boolean | null;
  operator_id: string;
}

const LOCK_OWN_SQL = `SELECT ot.operator_id::text AS operator_id, ot.is_published, ${LIVE_CONTENT_COLUMNS}
     FROM operator_tours ot
    WHERE ot.id = $1::bigint AND ot.deleted_at IS NULL AND ot.operator_id = $2::uuid
    FOR UPDATE`;

export async function saveTourChange(
  client: Pick<PoolClient, 'query'>,
  opts: {
    tourId: bigint | string;
    /** `partners.id` владельца тура; null — администратор. */
    ownerId: string | null;
    /** Кто сохраняет (users.id) — в черновик; у чата может не быть. */
    userId: string | null;
    input: TourPatchInput;
    /** Строка тура до правки (для главного места). */
    current: Record<string, unknown>;
  },
): Promise<TourChange> {
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
  const asksPublish = wantsPublish && !published;

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
  const written: TourChange = row
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
  });
  if (staged.outcome === 'none') return written;
  return {
    outcome: 'pending',
    row,
    pending: {
      editId: staged.editId,
      fields: staged.fields,
      wantsPublish: staged.wantsPublish,
      notice: pendingNotice(staged.fields, staged.wantsPublish, published),
    },
  };
}
