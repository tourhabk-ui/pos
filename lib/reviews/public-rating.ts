/**
 * Оценка, у которой есть источник.
 *
 * ── Почему недостаточно «пропускать NULL» ─────────────────────────────────
 *
 * Тип, допускающий отсутствие, — половина правила §4.0. Вторая половина в
 * данных, и она замерена на настоящем PostgreSQL (baseline прода + все
 * миграции, 26.09):
 *
 *   operator_tours.rating  DEFAULT 0     review_count DEFAULT 0
 *   partners.rating        DEFAULT 0.0   review_count DEFAULT 0
 *   accommodations.rating  без default   review_count DEFAULT 0
 *
 * То есть у двух таблиц из трёх «никто не оценивал» ЗАПИСАНО как ноль самой
 * базой: оба тура baseline и единственный партнёр стоят с `rating = 0.00` и
 * `review_count = 0`. Роут, добросовестно пропускающий NULL, на таких строках
 * по-прежнему отдал бы «нуль звёзд» — починка вышла бы бумажной.
 *
 * Поэтому оценка отдаётся, только когда у неё есть чем подтвердиться —
 * непустой счёт отзывов. Это не догадка о данных, а отказ утверждать без
 * источника: «4.5 у перевозчика, которого никто не оценивал» — тот самый
 * случай, с которого §4.0 началась, и ноль отличается от него лишь цифрой.
 *
 * Правило живёт ЗДЕСЬ, а не копией в четырёх выдачах (туры списком, карточка
 * тура, её оператор, жильё списком и карточкой): копия рядом с каждой — это
 * четыре правила, и разъехались бы они так же, как разъезжался шлюз витрины.
 *
 * Настоящий default колонки правится миграцией; она в этот заход не входит
 * (номера заняты другим исполнителем) — и правило от неё не зависит: после
 * смены default ноль просто перестанет приезжать.
 *
 * Сторож: `tests/unit/rating-null-not-zero.test.ts`.
 */

/**
 * @param rating      значение колонки rating (NUMERIC приезжает строкой)
 * @param reviewCount число отзывов из той же строки
 * @returns оценку числом либо null — «не оценивали»
 */
export function publicRating(rating: unknown, reviewCount: unknown): number | null {
  const count = typeof reviewCount === 'number' ? reviewCount : Number(reviewCount);
  // Счёта нет или он нулевой — подтверждать оценку нечем.
  if (!Number.isFinite(count) || count <= 0) return null;
  if (rating === null || rating === undefined || rating === '') return null;
  const value = typeof rating === 'number' ? rating : Number(rating);
  return Number.isFinite(value) ? value : null;
}
