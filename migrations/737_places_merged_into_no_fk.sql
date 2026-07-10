-- Migration 737: places.merged_into_id БЕЗ inline-FK (та же причина отката)
--
-- Прежние попытки (706/731/733/734) добавляли merged_into_id С inline-FK
-- `REFERENCES places(id)`, который на проде падает (нет подходящего unique/PK
-- на places.id) и откатывал транзакцию. FK здесь не нужен для работы: код
-- использует только `WHERE merged_into_id IS NULL` — целостность обеспечивает
-- прикладной слой (POST /api/admin/places/merge). Поэтому добавляем простой
-- UUID без ссылки. Каждый ALTER — своим оператором, атомарно.

ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_into_id UUID;
ALTER TABLE places ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_places_merged_into ON places(merged_into_id) WHERE merged_into_id IS NOT NULL;
