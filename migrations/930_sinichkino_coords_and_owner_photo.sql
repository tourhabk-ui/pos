-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 930: озеро Синичкино — координата на само озеро и свой снимок владельца.
--
-- ── Координата ────────────────────────────────────────────────────────────
--
-- Место стояло на 53.0787, 158.6382. Это трасса А-401 у кольца в микрорайоне
-- Северный: на OpenTopoMap в самом приложении маркер лежит на дороге, воды
-- рядом нет — при том что описание обещает «лес подступает к самой воде».
--
-- Источник правды — владелец, 02.09.2026 (скрин Organic Maps, данные OSM,
-- версия карты 251020): «озеро Синичкино» на 53.081481, 158.691467 — в 3.6 км
-- восточнее старой точки, за застройкой. Сторонний справочник eSosedi кладёт
-- озеро на 53.0789, 158.6475 — тоже восточнее старой точки, но грубее:
-- полигон OSM точнее точки справочника, берётся он.
--
-- coord_source — 'osm_organic_930': не 'surveyed' (прибором на берегу никто не
-- снимал), но и не 'unknown' — происхождение названо, по нему и откат.
--
-- ── Снимок ────────────────────────────────────────────────────────────────
--
-- Пост Кузьмича 02.09 вышел с куратор-фото и оговоркой «своего снимка у нас
-- пока нет». Снимок есть: его сделал владелец и прислал 02.09.2026
-- («это фото которое делал я»). Кладётся как manual-upload тем же путём и в
-- том же каноне, что и POST /api/admin/places/[id]/photo: sharp, rotate →
-- 1280x720 cover/attention → mozjpeg q85 (100 909 байт). Через миграцию, а не
-- через эндпоинт, потому что деплой применяет её сам — без ручного шага с
-- секретом; байты лежат прямо в SQL (decode(..., 'hex')): миграция —
-- единственный путь данных, который доезжает до прода вместе с кодом.
-- Hex разбит на строки по 96 знаков: смежные литералы через перевод строки
-- Postgres склеивает в один (стандарт SQL), а сторожа миграций перестают
-- давиться 200-килобайтной строкой.
--
-- Идемпотентно: координата — guard по старой точке; снимок — ON CONFLICT по
-- route_id, и уже лежащий НАСТОЯЩИЙ снимок (wikimedia / manual-upload) не
-- перезаписывается — только AI-блоб или пустота.

UPDATE places
   SET lat = 53.081481,
       lng = 158.691467,
       coord_source = 'osm_organic_930',
       coord_source_at = NOW(),
       updated_at = NOW()
 WHERE (id::text = '9330b39d-7afd-491b-9eaa-11d190c52c8c' OR ark_id::text = '9330b39d-7afd-491b-9eaa-11d190c52c8c')
   AND lat BETWEEN 53.07 AND 53.09
   AND lng BETWEEN 158.63 AND 158.65;

-- 13.10: колонки хранилища и снятый NOT NULL у байтов — те же, что заведёт 944;
-- здесь заранее и идемпотентно, потому что снимок ниже пишет s3_key, а не байты.
ALTER TABLE ai_route_images
  ADD COLUMN IF NOT EXISTS s3_key TEXT,
  ADD COLUMN IF NOT EXISTS s3_url TEXT;
ALTER TABLE ai_route_images ALTER COLUMN image_data DROP NOT NULL;

INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: озеро Синичкино, миграция 930',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/05ccf375a569824b5c4e33cec691f52ee021f7771baf8df4b9f3363ebf17fde8.jpg'
  FROM places p
 WHERE (p.id::text = '9330b39d-7afd-491b-9eaa-11d190c52c8c' OR p.ark_id::text = '9330b39d-7afd-491b-9eaa-11d190c52c8c')
   AND p.ark_id IS NOT NULL
 LIMIT 1
ON CONFLICT (route_id) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       s3_url     = NULL,
       s3_key     = EXCLUDED.s3_key,
       mime_type  = EXCLUDED.mime_type,
       prompt     = EXCLUDED.prompt,
       model      = EXCLUDED.model,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       author     = EXCLUDED.author,
       created_at = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload');
