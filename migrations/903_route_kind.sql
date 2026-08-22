-- 903: у записи маршрута появляется РОД (решение владельца 22.08, пункт 1).
--
-- Скрейп idilesom принёс ~257 записей, где «маршрут» значит «как добраться
-- до места»: заброска на машине плюс подход пешком. Это не путь и не место —
-- это свойство места, отвечающее на вопрос «как туда попасть». Пока род
-- негде было записать, такие записи стояли в каталоге путей наравне с
-- восхождениями, и отсюда шла вся странность: имена-места вместо путей,
-- линии из города, «45 км» у прогулки к источникам.
--
--   path      путь ногами: трек, сложность, снаряжение, регистрация МЧС
--   approach  «как добраться»: заброска + подход, свойство своего места
--   NULL      род не установлен — законное третье состояние (§4.0)
--
-- Колонка ставится ПУСТОЙ. Разметку делает актуатор
-- /api/cron/route-kind-classify по судье принадлежности (line-ownership):
-- род выводится из улики в самих данных, а не из имени поставщика и не из
-- догадки в SQL. Ошибётся — колонка обнуляется одним UPDATE, данные целы:
-- ни геометрия, ни имя, ни описание здесь не трогаются.

ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS route_kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kamchatka_routes_route_kind_check'
  ) THEN
    ALTER TABLE kamchatka_routes
      ADD CONSTRAINT kamchatka_routes_route_kind_check
      CHECK (route_kind IS NULL OR route_kind IN ('path', 'approach'));
  END IF;
END $$;

-- Кто и на каком основании поставил род — чтобы разметку можно было
-- пересмотреть, а не гадать о ней задним числом.
ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS route_kind_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_kamchatka_routes_kind
  ON kamchatka_routes (route_kind)
  WHERE is_visible = true AND merged_into_id IS NULL;
