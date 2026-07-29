-- 675: User-contributed photos for places
-- Tourists submit photos with caption; admin approves before display.
--
-- Правка 28.07: миграция не применялась ни разу с момента написания, и таблицы
-- в проде нет. Виноват inline-FK `place_id UUID REFERENCES places(id)`, и на
-- него есть два кандидата-объяснения, оба достаточные:
--   1) типы не совпадают — аудит боевой схемы показал `places.id` типа TEXT,
--      а не UUID (UUID у places лежит в отдельной колонке `ark_id`);
--   2) на `places.id` нет подходящего unique/PK — это причина, названная в
--      миграции 737, где по тому же поводу выкинули FK у merged_into_id.
-- Какая из них настоящая, я не знаю: настоящего текста ошибки ни у кого не
-- было — он оставался строчкой в логе деплоя. Поэтому не выбираю между
-- гипотезами, а снимаю зависимость от обеих: тип приводится к TEXT (совпадает
-- с родителем при любом раскладе), FK убирается — ровно как в 737, где это
-- уже признано допустимым: целостность держит прикладной слой.
--
-- Настоящую причину покажет `_migration_failures`: раннер миграций теперь
-- сохраняет текст ошибки в базу, а аудит его показывает.

CREATE TABLE IF NOT EXISTS user_place_photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id    TEXT NOT NULL,
  user_id     UUID,
  url         TEXT NOT NULL,
  caption     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID
);

CREATE INDEX IF NOT EXISTS idx_user_place_photos_place ON user_place_photos(place_id) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_user_place_photos_user ON user_place_photos(user_id);
CREATE INDEX IF NOT EXISTS idx_user_place_photos_pending ON user_place_photos(status) WHERE status = 'pending';
