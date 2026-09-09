-- 944: снимки мест переезжают из базы в S3.
--
-- ПОВОД — замер 08.09 (`GET /api/cron/db-size-census`, prod-check run 42).
-- База занимает 839,9 МБ, и БОЛЬШЕ ПОЛОВИНЫ этого — одна таблица:
-- ai_route_images, 439,6 МБ на 657 строк (~670 КБ на снимок). Картинки лежат
-- бинарём в PostgreSQL (image_data BYTEA), при том что рядом стоит S3 на
-- 100 ГБ — оплаченный, подключённый и уже используемый (lib/storage/s3.ts).
--
-- Комментарий миграции 107, которая эту таблицу завела: «AI-generated hero
-- images per route. TEMPORARY until real photos are uploaded by operators».
-- Временное решение прожило восемьсот с лишним миграций.
--
-- ЧТО ДЕЛАЕТ ЭТА МИГРАЦИЯ — только освобождает место для переезда:
--   s3_key / s3_url  — где снимок лежит в объектном хранилище;
--   image_data       — становится необязательным, чтобы строка могла жить
--                      уже БЕЗ байтов в базе.
--
-- Сам перенос она НЕ делает: это работа партиями с проверкой, что объект
-- читается (`POST /api/cron/images-to-s3`). Удалять байты из базы можно
-- только после того, как снимок подтверждённо читается из S3 — иначе
-- «переехало» окажется «потеряно», и узнаем мы об этом с чужого экрана.
--
-- Обратной несовместимости нет: пока s3_url пуст, отдача идёт как раньше,
-- из image_data.

ALTER TABLE ai_route_images
  ADD COLUMN IF NOT EXISTS s3_key TEXT,
  ADD COLUMN IF NOT EXISTS s3_url TEXT;

-- Строка без байтов — законное состояние ПОСЛЕ переезда, а не порча данных.
ALTER TABLE ai_route_images
  ALTER COLUMN image_data DROP NOT NULL;

-- Искать «что ещё не переехало» — по этому индексу, а не полным проходом.
CREATE INDEX IF NOT EXISTS idx_ai_route_images_pending_s3
  ON ai_route_images(id)
  WHERE s3_key IS NULL;

COMMENT ON COLUMN ai_route_images.s3_key IS
  'Ключ объекта в S3. NULL — снимок ещё в базе (image_data).';
COMMENT ON COLUMN ai_route_images.s3_url IS
  'Публичный URL снимка в S3. Заполнен — отдача идёт редиректом, байты в базе не нужны.';
