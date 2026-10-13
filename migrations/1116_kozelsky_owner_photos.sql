-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 1116: Козельский — снимки владельца на карточке места.
--
-- ── Повод ─────────────────────────────────────────────────────────────────
--
-- 30.09 владелец: «почему у места Козельский нет фото, там моё фото было».
-- Карточка (`/places/kozelskij`) отвечала photoCount 0. Строка снимка у места
-- при этом ЕСТЬ: /api/images/route/7190e0a4-52f1-47fb-ba17-0fcb493d99df отвечает 302 в хранилище
-- (объект places/7190e0a4-52f1-47fb-ba17-0fcb493d99df/f30b51e0-01bf-4d41-beed-bee7e3a1c76a.jpg,
-- 1066×800, настоящая съёмка — цветы у озера под снежными склонами, в S3 с
-- 19.09, увезён уборщиком images-to-s3). Карточка её не считает — значит, род
-- строки не из SHOWN_MODELS (lib/images/origin.ts): скрейп, чужой снимок без
-- автора или незнакомый род. Какой именно — с раннера не прочитать, и
-- выдумывать его здесь нельзя (§4.0).
--
-- На показанный снимок владелец своим его не назвал, а прислал два своих
-- кадра Козельского: «Козельский». Это и есть источник — слово человека,
-- которому снимки принадлежат. Подпись та же, что у прежних его кадров
-- (979, 999, 1002, 1009): «владелец платформы». Лицензия не ставится: снимок
-- собственный (правило 978).
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- Герой — дневной кадр с дорогой, 16:9, 960×540. У `ai_route_images` колонка
-- `route_id` уникальна, строка у места одна, поэтому:
--   0. строки нет — вставляется (NOT EXISTS, иначе duplicate key пропустит
--      накатчик молча, урок 988);
--   1. строка есть и она НЕ из показываемых родов — её содержимое
--      заменяется: байты, род manual-upload, автор. s3_key/s3_url
--      обнуляются, иначе раздача ушла бы редиректом на старый объект;
--      уборщик увезёт новые байты в хранилище следующим прогоном.
--      Граница — та же, что в 981/983/984/994, расширенная родом real-photo
--      (показывается с 18.09): чужой ПОКАЗЫВАЕМЫЙ снимок не трогаем ни при
--      каких обстоятельствах. Старый объект остаётся в бакете ничей —
--      у миграции нет и не должно быть доступа к хранилищу.
-- Галерея — закатный кадр, следующая свободная позиция; повтор узнаётся по
-- подписи.
--
-- ПОСЛЕ ВЫКАТА — перезалив пакетов карты не нужен: снимки в пакеты не
-- входят, координата и имя места не менялись.
--
-- IDEMPOTENT

BEGIN;

-- ── 0. Строки снимка нет — вставить ───────────────────────────────────────
INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Козельский вулкан, дорога к подножию днём (миграция 1116)',
       'manual-upload', 960, 540, 'владелец платформы',
       'migrations/photos/2a4c6d21995eb80ea8d90cfbb33088e3de1ca2cf99f376f28f2b91e1e5871e73.jpg'
  FROM places p
 WHERE p.id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df'
   AND p.ark_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ai_route_images ai WHERE ai.route_id = p.ark_id);

-- ── 1. Строка есть и не показывается — заменить содержимое ────────────────
UPDATE ai_route_images ai
   SET image_data = NULL, s3_key = 'migrations/photos/2a4c6d21995eb80ea8d90cfbb33088e3de1ca2cf99f376f28f2b91e1e5871e73.jpg',
       mime_type          = 'image/jpeg',
       prompt             = 'снимок владельца: Козельский вулкан, дорога к подножию днём (миграция 1116)',
       model              = 'manual-upload',
       width              = 960,
       height             = 540,
       author             = 'владелец платформы',
       license            = NULL,
       license_url        = NULL,
       source_url         = NULL,
       s3_url             = NULL,
       photo_verified     = NULL,
       ai_audit_reason    = NULL,
       ai_audit_at        = NULL,
       created_at         = NOW()
 WHERE ai.route_id = (SELECT ark_id FROM places WHERE id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df')
   AND (ai.model IS NULL OR ai.model NOT IN ('manual-upload', 'wikimedia', 'real-photo'));

-- ── 2. Галерея: закат ─────────────────────────────────────────────────────
INSERT INTO place_gallery_photos (ark_id, position, image_data, mime_type, width, height, caption, author, s3_key)
SELECT p.ark_id,
       COALESCE((SELECT MAX(g.position) FROM place_gallery_photos g WHERE g.ark_id = p.ark_id), 0) + 1,
       NULL::bytea,
       'image/jpeg', 960, 540,
       'Козельский на закате, вид с дороги',
       'владелец платформы',
       'migrations/photos/973283447660868f138a13b006d81dc109c2f02456e5607fb189646389886837.jpg'
  FROM places p
 WHERE p.id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df'
   AND p.ark_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM place_gallery_photos g
          WHERE g.ark_id = p.ark_id AND g.caption = 'Козельский на закате, вид с дороги'
       );

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_ark    uuid;
  v_prompt text;
  v_model  text;
  v_author text;
  v_gal    int;
BEGIN
  SELECT ark_id INTO v_ark FROM places WHERE id::text = '7190e0a4-52f1-47fb-ba17-0fcb493d99df';
  IF v_ark IS NULL THEN
    RAISE WARNING '[1116] у «Козельского» нет ark_id (или места нет) — снимкам встать некуда';
    RETURN;
  END IF;
  SELECT prompt, model, author INTO v_prompt, v_model, v_author FROM ai_route_images WHERE route_id = v_ark;
  IF v_prompt IS DISTINCT FROM 'снимок владельца: Козельский вулкан, дорога к подножию днём (миграция 1116)' THEN
    RAISE WARNING '[1116] герой НЕ заменён: на месте показываемый снимок (model=%, автор %) — чужой не трогаем',
      COALESCE(v_model, '—'), COALESCE(v_author, '—');
  END IF;
  SELECT count(*) INTO v_gal FROM place_gallery_photos WHERE ark_id = v_ark AND caption = 'Козельский на закате, вид с дороги';
  IF v_gal <> 1 THEN
    RAISE WARNING '[1116] закатный кадр в галерее: % строк вместо одной', v_gal;
  END IF;
END $$;

COMMIT;
