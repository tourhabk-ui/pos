-- 878: у отзывов о туре появляются поля модерации — в ИХ СОБСТВЕННОЙ таблице.
--
-- ── Что измерено ───────────────────────────────────────────────────────────
--
-- Перепись 19.08 прочитала типы из information_schema:
--
--   reviews.tour_id      uuid
--   operator_tours.id    bigint
--
-- Оператора uuid = bigint в Postgres нет, значит каждый JOIN между `reviews` и
-- турами падает целиком. На нём стояли операторская и админская модерация:
-- список отзывов оператора, его статистика, ответ на отзыв, админская
-- модерация. Ни одна из этих поверхностей не работала.
--
-- ── Почему не колонка в `reviews` ──────────────────────────────────────────
--
-- Соблазн был добавить `reviews.operator_tour_id BIGINT` и переписать
-- двадцать пять мест. Я так и начал, и остановился: отзывы о турах УЖЕ имеют
-- свою таблицу — `operator_tour_reviews` (tour_id bigint, миграция 087), по
-- ней работает карточка тура и `/api/reviews/tour/[tourId]`. Новая колонка
-- стала бы ТРЕТЬИМ местом для одного смысла.
--
-- Раздвоение это уже чинили однажды: 06.08 публичный путь перевели со старой
-- `reviews` на `operator_tour_reviews`, и в шапке того файла записано, что
-- вставка числового id в UUID-колонку падала всегда — «Оставить отзыв» не
-- срабатывал ни разу. Модерацию тогда не перевели, и она осталась на
-- нерабочей стороне.
--
-- ── Почему `is_hidden`, а не `is_verified` ─────────────────────────────────
--
-- В `reviews` поле зовётся `is_verified`, и по умолчанию FALSE: отзыв не
-- виден, пока его не одобрят. Перенести это имя нельзя, потому что смысл
-- здесь ДРУГОЙ: отзывы о турах публикуются сразу и уже опубликованы. Поставь
-- сюда `is_verified DEFAULT FALSE` — и все существующие отзывы исчезнут с
-- карточек в момент применения миграции.
--
-- А назвать `is_verified = TRUE` то, что никто не проверял, — соврать в имени
-- колонки. Поэтому `is_hidden`: по умолчанию FALSE (видно, как сейчас),
-- модерация прячет злоупотребление. Имя описывает то, что колонка делает.
--
-- Гейт честности отзыва остаётся прежним и лежит не здесь: отзыв принимается
-- только при завершённой брони этого тура.

ALTER TABLE operator_tour_reviews
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE operator_tour_reviews
  ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
ALTER TABLE operator_tour_reviews
  ADD COLUMN IF NOT EXISTS operator_reply TEXT;
ALTER TABLE operator_tour_reviews
  ADD COLUMN IF NOT EXISTS operator_reply_at TIMESTAMPTZ;
ALTER TABLE operator_tour_reviews
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN operator_tour_reviews.is_hidden IS
  'Отзыв скрыт модерацией. По умолчанию FALSE: отзывы о турах публикуются сразу, гейт честности — завершённая бронь.';
COMMENT ON COLUMN operator_tour_reviews.hidden_reason IS
  'Почему скрыт. Пустая причина — не решение, а мнение: скрывать без записи причины нельзя.';

-- Публичная выдача читает видимые отзывы конкретного тура — по этому и индекс.
CREATE INDEX IF NOT EXISTS idx_otr_tour_visible
  ON operator_tour_reviews (tour_id, created_at DESC) WHERE is_hidden = FALSE;

INSERT INTO _migrations (name)
VALUES ('878_tour_reviews_moderation.sql')
ON CONFLICT (name) DO NOTHING;
