/**
 * Строка экрана «Модерация отзывов» (/hub/admin/content/reviews) из ответа
 * /api/admin/content/reviews — отдельно от страницы: файл страницы Next не
 * может экспортировать ничего, кроме своих полей, а правило нужно сторожу.
 */

export interface AdminReview {
  id: string;
  userId: string;
  userName: string;
  tourId: string;
  subjectName: string;
  rating: number;
  comment: string;
  isVerified: boolean;
  createdAt: Date;
}

/** Строка ответа /api/admin/content/reviews (ReviewAdminRow, snake_case). */
export interface ApiReviewRow {
  id: string;
  user_id: string | null;
  tour_id: string | null;
  rating: string | number;
  comment: string | null;
  is_verified: boolean;
  created_at: string;
  user_name: string | null;
  subject_name: string | null;
}

/**
 * Ответ API → строка таблицы. До 13.10 страница читала data.data и
 * camelCase-поля, которых API не отдаёт, и слала verified= вместо status= —
 * список не открывался вовсе (соседняя /hub/admin/moderation была исправлена
 * тем же образом раньше).
 */
export function toAdminReview(r: ApiReviewRow): AdminReview {
  return {
    id: String(r.id),
    userId: r.user_id ?? '',
    userName: r.user_name ?? 'Аноним',
    tourId: r.tour_id ?? '',
    subjectName: r.subject_name ?? '—',
    rating: Number(r.rating) || 0,
    comment: r.comment ?? '',
    isVerified: r.is_verified === true,
    createdAt: new Date(r.created_at),
  };
}

