-- 1431: Снимок партнёра на карточке места — по его подписанному согласию
-- Created: 2026-11-12
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Владелец 12.11: «есть места и маршруты без фото — можем использовать фото
-- туров наших партнёров с подписями», на вопрос о согласии — «да,
-- подписывай». Текст согласия партнёра (lib/legal/partner-materials-consent)
-- с версии 2026-11-12 называет и это: снимки партнёра на карточках мест и
-- маршрутов с подписью «Фото: <партнёр>». Подпись прежней версии этого не
-- называла.
--
-- До сих пор снимок партнёра на карточке места прятали рукой: 1263
-- («Местечко Камчатка») и 1265 («Край Вулканов») поставили кадрам
-- `hidden_reason` до согласия, обещая вернуть их «одной правкой». Теперь
-- правило исполняет база, а не память: у кадра галереи есть `partner_id`, и
-- кадр с ним показывается только при действующем согласии нужной версии
-- (galleryShownSql, lib/places/gallery-shown.ts) — на карточке места, в фото
-- маршрута из его точек и по прямому адресу. Отзыв — кадр пропадает сам.
--
-- ── Что делает ────────────────────────────────────────────────────────────
--
--   1. колонка `partner_id` у place_gallery_photos;
--   2. кадрам «Местечка Камчатка» и «Края Вулканов» — их партнёр (по slug,
--      только если такой партнёр ровно один);
--   3. у тех же кадров снимается причина 1263/1265 — дальше их держит
--      согласие. Причина снимается ТОЛЬКО у кадра с проставленным партнёром:
--      иначе он показался бы без согласия.
--
-- Главные кадры этих партнёров (ai_route_images, род `partner-no-consent`)
-- не трогаются: у главного кадра партнёра нет, и согласием он не управляется.
-- Снимок партнёра кладётся на карточку места кадром галереи с `partner_id`.
-- Место без своего героя показывает первым кадр галереи.
--
-- IDEMPOTENT

BEGIN;

ALTER TABLE place_gallery_photos ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id);

CREATE INDEX IF NOT EXISTS idx_place_gallery_photos_partner
  ON place_gallery_photos (partner_id) WHERE partner_id IS NOT NULL;

UPDATE place_gallery_photos
   SET partner_id = (SELECT id FROM partners WHERE slug = 'mestechko')
 WHERE author = 'Местечко Камчатка'
   AND partner_id IS NULL
   AND (SELECT count(*) FROM partners WHERE slug = 'mestechko') = 1;

UPDATE place_gallery_photos
   SET partner_id = (SELECT id FROM partners WHERE slug = 'volcanoesland')
 WHERE author = 'Край Вулканов'
   AND partner_id IS NULL
   AND (SELECT count(*) FROM partners WHERE slug = 'volcanoesland') = 1;

UPDATE place_gallery_photos
   SET hidden_reason = NULL
 WHERE partner_id IS NOT NULL
   AND (hidden_reason LIKE 'снимок партнёра «Местечко Камчатка»%'
     OR hidden_reason LIKE 'снимок партнёра «Край Вулканов»%');

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_bound int;
  v_unbound_shown int;
BEGIN
  SELECT count(*) INTO v_bound
    FROM place_gallery_photos
   WHERE author IN ('Местечко Камчатка', 'Край Вулканов') AND partner_id IS NOT NULL;
  -- Кадр партнёра без привязки и без причины показывался бы без согласия.
  SELECT count(*) INTO v_unbound_shown
    FROM place_gallery_photos
   WHERE author IN ('Местечко Камчатка', 'Край Вулканов')
     AND partner_id IS NULL AND hidden_reason IS NULL;

  IF v_unbound_shown > 0 THEN
    RAISE WARNING '[1431] кадров партнёров без привязки и без причины: % — показываются без согласия', v_unbound_shown;
  END IF;
  RAISE NOTICE '[1431] кадров галереи привязано к партнёрам: %', v_bound;
END $$;

COMMIT;
