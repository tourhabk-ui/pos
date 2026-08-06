-- 832: Путь записи отзывов о туре — в ту же таблицу, откуда карточка читает.
--
-- Раздвоение с марта 2026: карточка тура ПОКАЗЫВАЕТ operator_tour_reviews
-- (BIGINT tour_id, миграция 087), а форма отправки писала в старую reviews
-- с tour_id UUID → FK на удалённую таблицу tours. Вставка числового id
-- операторского тура в UUID-колонку падает всегда — «Оставить отзыв» не мог
-- сработать ни разу (владелец поймал 06.08: «Ошибка при создании отзыва»).
-- Сама 087 об этом предупреждала: «tour_id in reviews is UUID,
-- operator_tours.id is bigint».
--
-- Дополняем живую таблицу до полноценного пути записи:
--   user_id — кто написал (гейт «только после завершённой брони» + дедуп);
--   photos  — фото туристов (S3 заработал 06.08, write_test: ok).

ALTER TABLE operator_tour_reviews
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE operator_tour_reviews
  ADD COLUMN IF NOT EXISTS photos TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_operator_tour_reviews_tour
  ON operator_tour_reviews (tour_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_tour_reviews_user
  ON operator_tour_reviews (user_id) WHERE user_id IS NOT NULL;
