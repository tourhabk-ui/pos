/**
 * Какой пост Кузьмича идёт в слот крона.
 *
 * Владелец 05.09: «я не вижу постов у Кузьмича про реальные туры — вместо
 * сезонов можно публиковать туры, пока их немного, но уже можно». Слот 19:00
 * KMT с 24.08 чередовал sezon/tour по чётности дня — но чередование жило в
 * pickTypeByHour, а внешний планировщик (cron-job.org) зовёт эндпоинт с явным
 * `type=sezon`, и явный тип побеждал: ветка «tour» по расписанию могла не
 * выполняться ни разу. Подтвердить, как настроен cron-job.org, из репозитория
 * нельзя — поэтому решение не зависит от него: `sezon` теперь ОЗНАЧАЕТ тур,
 * и по часу тот же слот тоже отдаёт тур. Сезонный пост остаётся только
 * ручной командой.
 */
export type KuzmichPostType = 'route' | 'tip' | 'sezon' | 'friend' | 'tour';

export interface ResolvedPostType {
  type: KuzmichPostType;
  /** Что просили, если итог отличается (sezon → tour). */
  requested?: KuzmichPostType;
}

const KNOWN: ReadonlySet<string> = new Set(['route', 'tip', 'sezon', 'friend', 'tour']);

export function isKuzmichPostType(v: string | null | undefined): v is KuzmichPostType {
  return !!v && KNOWN.has(v);
}

/** Слот по часу UTC (Камчатка UTC+12): утро — место, день — совет, вечер — тур. */
export function pickTypeByHour(now: Date = new Date()): KuzmichPostType {
  const h = now.getUTCHours();
  if (h >= 20 && h <= 22) return 'route';  // 08–10 KMT
  if (h >= 1  && h <= 3)  return 'tip';    // 13–15 KMT
  if (h >= 6  && h <= 8)  return 'tour';   // 18–20 KMT — вечерний слот продаёт
  return 'route';
}

export function resolvePostType(typeParam: string | null, now: Date = new Date()): ResolvedPostType {
  const requested = isKuzmichPostType(typeParam) ? typeParam : pickTypeByHour(now);
  if (requested === 'sezon') return { type: 'tour', requested: 'sezon' };
  return { type: requested };
}
