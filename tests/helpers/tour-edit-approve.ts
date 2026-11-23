/**
 * Администратор одобряет правку тура, которая ждёт проверки, — тем же путём,
 * что очередь /hub/admin/moderation (план готовности 23.11, этап 4).
 *
 * Для pg-тестов, которые судят двери владельца (чат, сайт): «Сохранить» кладёт
 * содержание на проверку, а на витрину оно выходит после одобрения. Саму
 * модерацию судит tests/integration/tour-moderation.pg.test.ts.
 */
export async function approveTourEdit(tourId: string): Promise<void> {
  const { listPendingTourEdits, decideTourEdit } = await import('@/lib/tours/moderation-store');
  const listed = await listPendingTourEdits();
  if (listed.outcome !== 'ok') throw new Error('очередь правок не прочитана');
  const edit = listed.edits.find((e) => e.tourId === String(tourId));
  if (!edit) throw new Error(`у тура ${tourId} нет правки на проверке`);
  const r = await decideTourEdit({ id: edit.id, action: 'approve', reason: null, moderatedBy: null, seen: edit.seen });
  if (r.outcome !== 'approved') throw new Error(`правка тура ${tourId} не одобрена: ${r.outcome}`);
}

/** Сколько правок тура ждёт проверки. */
export async function pendingTourEdits(tourId: string): Promise<number> {
  const { listPendingTourEdits } = await import('@/lib/tours/moderation-store');
  const listed = await listPendingTourEdits();
  if (listed.outcome !== 'ok') throw new Error('очередь правок не прочитана');
  return listed.edits.filter((e) => e.tourId === String(tourId)).length;
}
