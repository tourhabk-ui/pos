/**
 * Имя автора отзыва для публичной страницы: имя и первая буква фамилии.
 *
 * Отзыв виден всем, и полное имя с фамилией — уже лишнее о человеке, а
 * email не нужен вовсе: до 26.09 публичный GET объекта жилья отдавал
 * reviews[].user.email каждого автора, и адреса гостей собирались перебором
 * id объектов. Нет имени — «Гость», а не пустая строка.
 */
export function publicReviewerName(fullName: string | null | undefined): string {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Гость';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.`;
}
