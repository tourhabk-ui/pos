-- 1436: Снимки туров партнёров на семи местах без фото — по согласию партнёра
-- Created: 2026-11-12
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Владелец 12.11: «есть места и маршруты без фото — можем использовать фото
-- туров наших партнёров с подписями», на порядок — «согласен». Перепись
-- prod-check 179 (place-photo-coverage?list=partner_candidates): без единого
-- показываемого кадра 305 мест, из них к семи ЗАПИСАНЫ туры партнёров со
-- снимками (главное место тура). Остальные к турам не привязаны — по
-- похожести имён ничего не подбиралось.
--
-- ── Правило ───────────────────────────────────────────────────────────────
--
--   - каждому партнёру с туром к месту — один снимок из этого тура, без
--     предпочтений между партнёрами (CLAUDE.md §0): порядок в галерее —
--     по алфавиту имени партнёра;
--   - снимок — обложка тура, кроме трёх, где на обложке не само место
--     (просмотрено глазами 12.11): у «Местечка Камчатка» к Горелому —
--     деревянные идолы, к Долине гейзеров — вертолёт и люди, у «Лагуны
--     Экспедиции» к Карымшинским источникам — вездеход; взят другой кадр того
--     же тура с самим местом;
--   - кадр — галереей места с `partner_id` (1431): он показывается только
--     при действующем согласии партнёра версии, называющей карточки мест
--     (galleryShownSql), подпись — «Фото: <партнёр>» со ссылкой на его
--     страницу. Пока партнёр не подписал, кадр лежит и не показывается;
--   - объект — тот же, что у тура (`photos/<партнёр>/…` в хранилище, ключ
--     без копирования), размер — самого файла `media/s3/…` (прочитан 12.11).
--
-- Повтор ничего не добавляет: кадр с тем же ключом у места уже есть — строки
-- нет. Партнёр или место не найдены по slug — строки нет, и это названо.
--
-- IDEMPOTENT

BEGIN;

-- ── Удаление партнёра (поправка CI #3303) ──────────────────────────────────
--
-- 1431 завела ссылку `partner_id` без правила удаления, и удалить партнёра,
-- у которого есть кадр на карточке места, стало нельзя (23503: так упал
-- посев проката, удаляющий «Лагуну Экспедицию»). Кадр партнёра без партнёра
-- показан быть не может — согласия нет, — поэтому он уходит вместе с
-- партнёром, как и само согласие (partner_material_consents, ON DELETE
-- CASCADE). SET NULL здесь недопустим: кадр без partner_id показывается
-- всегда, то есть удаление партнёра открыло бы его снимки без согласия.
ALTER TABLE place_gallery_photos DROP CONSTRAINT IF EXISTS place_gallery_photos_partner_id_fkey;
ALTER TABLE place_gallery_photos
  ADD CONSTRAINT place_gallery_photos_partner_id_fkey
  FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE;

CREATE TEMP TABLE _shots1436 (
  place_slug   text,
  partner_slug text,
  s3_key       text,
  width        int,
  height       int,
  caption      text,
  ord          int
) ON COMMIT DROP;

INSERT INTO _shots1436 (place_slug, partner_slug, s3_key, width, height, caption, ord) VALUES
  ('vulkan-gorelyj', 'andrey-zaporozhets', 'photos/zaporozhets/gorely-crater-lake.jpg', 1600, 1205,
   'Кратерное озеро Горелого — снимок с тура «Восхождение на вулкан Горелый и лавовые пещеры»', 1),
  ('vulkan-gorelyj', 'mestechko', 'photos/mestechko/vulkan-gorelyy-05.jpg', 800, 533,
   'Кратер Горелого — снимок с тура «Вулкан Горелый»', 2),
  ('vulkan-ploskij-tolbachik', 'andrey-zaporozhets', 'photos/zaporozhets/tolbachik-plosky-view.jpg', 1200, 1600,
   'Плоский Толбачик — снимок с тура «Толбачик: по следам извержений, 4 дня»', 1),
  ('vulkan-ploskij-tolbachik', 'volcanoesland', 'photos/volcanoesland/ploskiy-tolbachik-01.jpg', 902, 507,
   'Снимок с тура «Вулкан Плоский Толбачик»', 2),
  ('dolina-gejzerov', 'volcanoesland', 'photos/volcanoesland/dolina-geyzerov-kaldera-uzon-03.jpg', 902, 507,
   'Долина гейзеров — снимок с тура «Экскурсия в Долину гейзеров и кальдеру вулкана Узон»', 1),
  ('dolina-gejzerov', 'mestechko', 'photos/mestechko/dolina-geyzerov-03.jpg', 1200, 860,
   'Долина гейзеров — снимок с тура «Долина гейзеров (вертолёт)»', 2),
  ('severnyj-proryv', 'mestechko', 'photos/mestechko/vertolet-tolbachik-04.jpg', 1200, 860,
   'Шлаковые конусы Северного прорыва — снимок с тура «Вулкан Толбачик (вертолёт)»', 1),
  ('kanon-opasnyj', 'laguna-expedition', 'photos/laguna-expedition/kanon-opasnyj-cover.jpg', 1280, 1600,
   'Каньон Опасный — снимок с тура «Высадка на Марс: экспедиция в каньон Опасный»', 1),
  ('karymshinskie-istochniki', 'laguna-expedition', 'photos/laguna-expedition/karymshinskie-termalnye-istochniki-1.jpg', 1280, 960,
   'Карымшинские источники — снимок с тура «Дикие термальные источники на вездеходе Sever Truck»', 1),
  ('zelenovskie-ozerki', 'laguna-expedition', 'photos/laguna-expedition/zelenovskie-ozerki-cover.jpg', 1600, 1195,
   'Зеленовские озерки — снимок с тура «Зеленовские озерки»', 1);

INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height,
                                  caption, author, license, license_url, source_url, s3_key, partner_id)
SELECT p.ark_id,
       COALESCE((SELECT max(g.position) FROM place_gallery_photos g WHERE g.ark_id = p.ark_id), 0) + s.ord,
       NULL::bytea, 'image/jpeg', s.width, s.height,
       s.caption, pa.name, NULL::text, NULL::text, NULL::text, s.s3_key, pa.id
  FROM _shots1436 s
  JOIN places p ON p.slug = s.place_slug AND p.merged_into_id IS NULL
  JOIN partners pa ON pa.slug = s.partner_slug
 WHERE p.ark_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM place_gallery_photos g
                    WHERE g.ark_id = p.ark_id AND g.s3_key = s.s3_key)
ON CONFLICT (ark_id, position) DO NOTHING;

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_expected int;
  v_present int;
  v_missing text;
BEGIN
  SELECT count(*) INTO v_expected FROM _shots1436;
  SELECT count(*) INTO v_present
    FROM _shots1436 s
    JOIN places p ON p.slug = s.place_slug AND p.merged_into_id IS NULL
    JOIN partners pa ON pa.slug = s.partner_slug
    JOIN place_gallery_photos g ON g.ark_id = p.ark_id AND g.s3_key = s.s3_key AND g.partner_id = pa.id;
  SELECT string_agg(s.place_slug || ' / ' || s.partner_slug, ', ') INTO v_missing
    FROM _shots1436 s
   WHERE NOT EXISTS (SELECT 1 FROM places p WHERE p.slug = s.place_slug AND p.merged_into_id IS NULL AND p.ark_id IS NOT NULL)
      OR NOT EXISTS (SELECT 1 FROM partners pa WHERE pa.slug = s.partner_slug);

  IF v_missing IS NOT NULL THEN
    RAISE WARNING '[1436] место или партнёр не найдены по slug: %', v_missing;
  END IF;
  RAISE NOTICE '[1436] кадров партнёров на местах: % из %', v_present, v_expected;
END $$;

COMMIT;
