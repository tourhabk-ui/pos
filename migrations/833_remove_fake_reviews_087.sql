-- 833: Убрать выдуманные отзывы, насеянные миграцией 087.
--
-- Источник: владелец, 07.08.2026 — «убери выдуманные отзывы из 087».
--
-- 087 (март 2026) вставила в operator_tour_reviews ~20 отзывов с вымышленными
-- именами и городами («Сергей Михайлов, Москва» и т.д.) на туры 4-11 и
-- захардкодила operator_tours.rating/review_count числами, не сходящимися даже
-- с собственным сидом («4.8, 31 отзыв» при трёх вставленных). На витрине
-- честной платформы выдуманным отзывам не место: они кормили и карточку, и
-- JSON-LD AggregateRating для поисковиков.
--
-- Идентификация точная, а не по списку имён: путь записи отзывов появился
-- только с миграцией 832 и всегда проставляет user_id (гейт завершённой
-- брони требует авторизацию). Значит user_id IS NULL = сид 087 — других
-- источников строк без user_id не существовало.

DELETE FROM operator_tour_reviews WHERE user_id IS NULL;

-- Рейтинг и счётчик — только от живых отзывов. Нет отзывов — нет рейтинга
-- (NULL, карточка честно не показывает звёзды), а не выдуманные «4.9».
UPDATE operator_tours ot SET
  rating = (SELECT ROUND(AVG(r.rating)::numeric, 1)
              FROM operator_tour_reviews r WHERE r.tour_id = ot.id),
  review_count = (SELECT COUNT(*)
              FROM operator_tour_reviews r WHERE r.tour_id = ot.id),
  updated_at = NOW()
WHERE ot.deleted_at IS NULL;
