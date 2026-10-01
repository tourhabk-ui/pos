/**
 * Описание в карточке каталога — выдержкой, а не целым текстом.
 *
 * Карточка показывает две строки (`line-clamp-2`), а в HTML лежало описание
 * целиком: у статей «Камчатского лексикона» (kl-*) это 14–23 КБ на карточку.
 * Замер 01.10: первый HTML /routes весил 970 КБ, из них 397 КБ — полные
 * тексты 23 карточек, и ещё раз столько же — в данных для гидратации.
 *
 * Режется только то, что сервер отдаёт в первом HTML. Опасности карточки
 * (`resolveHazards`) считаются по полному тексту раньше, внутри queryCatalog.
 */
import { metaDescription } from '@/lib/seo/meta-description';

/** Две строки мелкого текста с запасом. */
export const CARD_DESCRIPTION_MAX = 240;

export function withCardExcerpts<T extends { description: string }>(items: T[]): T[] {
  return items.map((it) => ({ ...it, description: metaDescription(it.description, CARD_DESCRIPTION_MAX) }));
}
