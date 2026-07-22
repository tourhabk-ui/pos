-- Migration 766: «умные» подборки — правило-фильтр вместо ручных массивов id.
--
-- Проблема: миграция 665 создала таблицу collections с ручными place_ids[]/
-- route_ids[], но все 4 сид-подборки засеяны ПУСТЫМИ массивами. В хедере есть
-- ссылка «Подборки» → пользователь открывает «Вулканы Камчатки» и видит НОЛЬ
-- вулканов. На платформе с 778 точками это прямое нарушение «не врём цифрами».
--
-- Решение: подборка может задаваться правилом-фильтром (kind/location_type/
-- activity_type/difficulty/query) поверх того же каталога (agent_route_knowledge,
-- is_visible), что видит турист на /routes. Члены подборки резолвятся вживую и
-- честно — ничего не выдумываем, ничего не устаревает. Ручные массивы остаются
-- как запасной вариант (если правила нет).

ALTER TABLE collections ADD COLUMN IF NOT EXISTS rule_kind          VARCHAR(10);
ALTER TABLE collections ADD COLUMN IF NOT EXISTS rule_location_type VARCHAR(60);
ALTER TABLE collections ADD COLUMN IF NOT EXISTS rule_activity_type VARCHAR(60);
ALTER TABLE collections ADD COLUMN IF NOT EXISTS rule_difficulty    VARCHAR(20);
ALTER TABLE collections ADD COLUMN IF NOT EXISTS rule_query         VARCHAR(200);
ALTER TABLE collections ADD COLUMN IF NOT EXISTS rule_limit         INT DEFAULT 60;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS accent             VARCHAR(20) DEFAULT 'accent';

-- Только 'place' или 'route' (или NULL — тогда работают ручные массивы)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE constraint_name = 'collections_rule_kind_check'
  ) THEN
    ALTER TABLE collections
      ADD CONSTRAINT collections_rule_kind_check
      CHECK (rule_kind IS NULL OR rule_kind IN ('place', 'route'));
  END IF;
END $$;

-- Оживляем 4 существующие сид-подборки честными правилами
UPDATE collections SET rule_kind = 'place', rule_location_type = 'volcano',    accent = 'accent'
  WHERE slug = 'vulkany-kamchatki';
UPDATE collections SET rule_kind = 'place', rule_location_type = 'hot_spring', accent = 'ocean'
  WHERE slug = 'goryachie-istochniki';
UPDATE collections SET rule_kind = 'route', rule_difficulty = 'easy',          accent = 'success'
  WHERE slug = 'marshruty-dlya-nachinayushchikh';
UPDATE collections SET rule_kind = 'route', rule_activity_type = 'eco',        accent = 'success'
  WHERE slug = 'dikaya-priroda';

-- Ещё две наполненные подборки из реальных типов точек (по максимуму)
INSERT INTO collections (slug, title, description, tags, rule_kind, rule_location_type, accent, place_ids, route_ids) VALUES
(
  'ozera-kamchatki',
  'Озёра Камчатки',
  'Кальдерные, ледниковые и тундровые озёра полуострова — от Курильского с нерестом лосося до высокогорных зеркал. У каждого озера — координаты, безопасность подхода и маршруты.',
  ARRAY['озёра', 'природа', 'фотография'],
  'place', 'lake', 'ocean',
  ARRAY[]::UUID[], ARRAY[]::UUID[]
),
(
  'vodopady-kamchatki',
  'Водопады Камчатки',
  'Водопады среди вулканического рельефа и каменноберёзовых лесов. Лучшее время, подходы и опасности — на карточке каждого места.',
  ARRAY['водопады', 'природа', 'треккинг'],
  'place', 'waterfall', 'ocean',
  ARRAY[]::UUID[], ARRAY[]::UUID[]
)
ON CONFLICT (slug) DO NOTHING;
