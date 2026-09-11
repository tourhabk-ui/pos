/**
 * Статус партнёрской заявки — один словарь на все экраны.
 *
 * Прогулка оператором 11.09 (#1798): онбординг писал «Заявка одобрена» ВСЕМ,
 * кроме `pending` — то есть и тому, кто заявку не подавал (`none`), и тому,
 * кому отказали (`rejected`). Профиль в это же время печатал сырое «none»,
 * потому что его собственный словарь (`draft/pending/active/rejected/inactive`)
 * и CHECK базы (`none/pending/approved/rejected`) совпадали ровно в двух
 * значениях из пяти. Место, где нельзя сказать «не знаю», заполняется
 * враньём (§4.0) — здесь у каждого из четырёх значений своя подпись, а у
 * неизвестного значения честное «статус неизвестен».
 *
 * Источник истины — CHECK в миграции партнёров:
 *   profile_status TEXT NOT NULL DEFAULT 'none'
 *     CHECK (profile_status IN ('none','pending','approved','rejected'))
 */

export const PROFILE_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export function isProfileStatus(value: unknown): value is ProfileStatus {
  return typeof value === 'string' && (PROFILE_STATUSES as readonly string[]).includes(value);
}

interface StatusView {
  /** Короткая подпись рядом с заголовком экрана. */
  label: string;
  /** Строка в шапке онбординга: что с заявкой прямо сейчас. */
  onboarding: string;
  /** Класс цвета из токенов DS. */
  color: string;
}

const VIEWS: Record<ProfileStatus, StatusView> = {
  none: {
    label: 'Заявка не подана',
    onboarding: 'заявка ещё не подана',
    color: 'text-[var(--text-muted)]',
  },
  pending: {
    label: 'На проверке',
    onboarding: 'заявка на рассмотрении',
    color: 'text-[var(--warning)]',
  },
  approved: {
    label: 'Одобрен',
    onboarding: 'заявка одобрена',
    color: 'text-[var(--success)]',
  },
  rejected: {
    label: 'Отклонён',
    onboarding: 'заявка отклонена',
    color: 'text-[var(--danger)]',
  },
};

const UNKNOWN: StatusView = {
  label: 'Статус неизвестен',
  onboarding: 'статус заявки неизвестен',
  color: 'text-[var(--text-muted)]',
};

/** Вид статуса. Значение вне CHECK не показывается сырым — «не знаю» словами. */
export function profileStatusView(value: unknown): StatusView {
  return isProfileStatus(value) ? VIEWS[value] : UNKNOWN;
}
