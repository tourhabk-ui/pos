/**
 * lib/planner/group-minimum.ts — минимум группы тура (аудит планировщика
 * 07.11, волна 3.3, E3).
 *
 * У тура бывает нижняя граница группы (`operator_tours.min_participants`):
 * выезд идёт, только если набралось столько человек. До 07.11 движок читал
 * её и не использовал нигде: один человек на туре с минимумом 4 получал день
 * без единого слова — план обещал выезд, которого может не быть.
 *
 * Строка одна на движок и на правку плана: правка состава («нас трое»)
 * снимает прежнюю строку и ставит новую — или не ставит, если группа уже
 * дотягивает. Выезд при наборе подтверждает оператор: собирает ли он
 * сборную группу, план не знает и не обещает.
 */

/** Начало строки: по нему правка плана находит прежнюю строку дня. */
export const GROUP_MINIMUM_PREFIX = 'Нужен набор группы';

/**
 * Строка дня о минимуме группы; `null` — минимума нет, он не записан или
 * группа до него дотягивает.
 */
export function groupMinimumNote(minParticipants: number | null | undefined, people: number): string | null {
  if (typeof minParticipants !== 'number' || !Number.isFinite(minParticipants)) return null;
  const min = Math.floor(minParticipants);
  if (min <= 1 || people >= min) return null;
  return `${GROUP_MINIMUM_PREFIX} от ${min} чел.: вас ${people}. Выезд подтверждает оператор.`;
}

/** Строки дня с актуальной строкой минимума: прежняя снимается, новая — первой. */
export function withGroupMinimum(
  warnings: readonly string[] | undefined,
  minParticipants: number | null | undefined,
  people: number,
): string[] {
  const rest = (warnings ?? []).filter((w) => !w.startsWith(GROUP_MINIMUM_PREFIX));
  const note = groupMinimumNote(minParticipants, people);
  return note ? [note, ...rest] : rest;
}
