-- 1513: Зеленовские озерки — два снимка озера Андрея Запорожца в галерею места
-- Created: 2026-11-26
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Владелец 26.11 прислал «Зеленовские озерки» и четыре снимка, затем: «Автор
-- Андрей запорожец а 4 не ставим чужой». У карточки места был один кадр —
-- обложка тура «Лагуны Экспедиции» (1436).
--
-- ── Что ставится ──────────────────────────────────────────────────────────
--
--   ozero-letom.jpg  — озеро летом, деревянная лестница к воде (720×539);
--   ozero-zimoy.jpg  — то же озеро зимой, у полыньи утки (580×1290).
--
-- Подписи говорят то, что видно на кадре: чем озеро питается и какая в нём
-- вода, по снимку не определить, и подпись этого не утверждает.
--
-- ── Что не ставится ───────────────────────────────────────────────────────
--
--   - снимок бассейнов со знаком topkam.ru и подписью другого автора — чужой;
--   - снимок бассейнов с узнаваемыми людьми — ждёт отдельного слова владельца.
--
-- ── Чьи снимки и как подписаны ────────────────────────────────────────────
--
-- Автора назвал владелец. Андрей Запорожец заведён партнёром-гидом
-- (`andrey-zaporozhets`), поэтому кадры ложатся снимками партнёра
-- (`partner_id`, 1431), как его кадр на карточке Горелого (1436): подпись —
-- «Фото: Андрей Запорожец» со ссылкой на его страницу, имя берётся из
-- карточки партнёра (lib/places/place-detail).
--
-- Объекты залиты media-to-s3 (прогон 29) предыдущим PR и прочитаны обратно;
-- исходники пересохранены в JPEG без EXIF. Размеры — самих файлов.
--
-- Повтор ничего не добавляет: кадр с тем же ключом у места уже есть — строки
-- нет. Место или партнёр не найдены по slug — строки нет, и это названо.
--
-- IDEMPOTENT

BEGIN;

CREATE TEMP TABLE _shots1513 (
  place_slug text, partner_slug text, s3_key text, width int, height int, caption text, ord int
) ON COMMIT DROP;

INSERT INTO _shots1513 (place_slug, partner_slug, s3_key, width, height, caption, ord) VALUES
  ('zelenovskie-ozerki', 'andrey-zaporozhets', 'photos/zaporozhets/zelenovskie-ozerki-ozero-letom.jpg', 720, 539,
   'Озеро на Зеленовских озерках летом, лестница к воде', 1),
  ('zelenovskie-ozerki', 'andrey-zaporozhets', 'photos/zaporozhets/zelenovskie-ozerki-ozero-zimoy.jpg', 580, 1290,
   'Озеро на Зеленовских озерках зимой, утки у полыньи', 2);

INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height,
                                  caption, author, license, license_url, source_url, s3_key, partner_id)
SELECT p.ark_id,
       COALESCE((SELECT max(g.position) FROM place_gallery_photos g WHERE g.ark_id = p.ark_id), 0) + s.ord,
       NULL::bytea, 'image/jpeg', s.width, s.height,
       s.caption, pa.name, NULL::text, NULL::text, NULL::text, s.s3_key, pa.id
  FROM _shots1513 s
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
  SELECT count(*) INTO v_expected FROM _shots1513;
  SELECT count(*) INTO v_present
    FROM _shots1513 s
    JOIN places p ON p.slug = s.place_slug AND p.merged_into_id IS NULL
    JOIN partners pa ON pa.slug = s.partner_slug
    JOIN place_gallery_photos g ON g.ark_id = p.ark_id AND g.s3_key = s.s3_key AND g.partner_id = pa.id;
  SELECT string_agg(s.place_slug || ' / ' || s.partner_slug, ', ') INTO v_missing
    FROM _shots1513 s
   WHERE NOT EXISTS (SELECT 1 FROM places p WHERE p.slug = s.place_slug AND p.merged_into_id IS NULL AND p.ark_id IS NOT NULL)
      OR NOT EXISTS (SELECT 1 FROM partners pa WHERE pa.slug = s.partner_slug);

  IF v_missing IS NOT NULL THEN
    RAISE WARNING '[1513] место или партнёр не найдены по slug: %', v_missing;
  END IF;
  IF v_present < v_expected THEN
    RAISE WARNING '[1513] снимков озера на карточке места: % из %', v_present, v_expected;
  ELSE
    RAISE NOTICE '[1513] снимков озера на карточке места: % из %', v_present, v_expected;
  END IF;
END $$;

COMMIT;

-- Откат (снимки — не данные места, убрать их ничего не ломает):
-- DELETE FROM place_gallery_photos
--  WHERE s3_key IN ('photos/zaporozhets/zelenovskie-ozerki-ozero-letom.jpg',
--                   'photos/zaporozhets/zelenovskie-ozerki-ozero-zimoy.jpg');
