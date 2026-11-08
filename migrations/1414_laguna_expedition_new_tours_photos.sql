-- 1414: снимки шести новых туров «Лагуны Экспедиции» (1413).
--
-- ── Основание ─────────────────────────────────────────────────────────────
-- Туры заведены 1413 по слову владельца 08.11 «да». Снимки с сайта оператора
-- — по его же слову 29.10 «они дали добро на использоваеие» (1343). Хранение
-- — правило §4.1: байтов в базе и в образе нет, файлы в хранилище.
-- Записанного согласия партнёра (partner_material_consents, 1321) по-прежнему
-- нет — тот же открытый пункт, что в 1343.
--
-- ── Откуда снимки и как отобраны ──────────────────────────────────────────
-- Со страниц тех же туров laguna-expedition.ru/tours/<id>-<адрес> (source_url
-- в 1413), снято 08.11.2026. Со страниц разобрано глазами 110 кадров, взято
-- 29 (27 файлов: два кадра стоят у двух туров — Дачные источники у летних
-- маршрутов, отель «Лагуна» у пятидневного и зимнего). Не взяты, по правилам
-- 1343:
--   • наклейки «11.11», ценник «45 000 ₽» и «Скидка −20 000 ₽» поверх кадра;
--   • рисунки вместо снимков (хаски, термальный бассейн, вездеход с туристкой),
--     коллаж полароидов, инфографика «Рекомендуем взять с собой», открытка,
--     кружка с надписью;
--   • люди главными в кадре: лица крупным планом, групповое селфи, туристы,
--     позирующие на вездеходе и с рыбой;
--   • кадры, обещающие то, чего в программе нет: Дед Мороз (новогодний тур),
--     ездовые собаки (у пятидневного вместо упряжки — стойбище), Халактырский
--     пляж у «летнего экспресса» (на пляж у него только трансфер за доплату);
--   • повторы и слабее отобранных (тот же вид, мелкий файл, игрушечная машинка).
--
-- ── Как хранятся ──────────────────────────────────────────────────────────
-- Пережаты до 1600 px по длинной стороне, прогрессивный JPEG 82, метаданные
-- сняты; лежат в media/s3/photos/laguna-expedition/ с копиями
-- .320/.640/.1280.webp (scripts/optimize-images.mjs, манифест
-- lib/images/photo-variants.json). В хранилище их кладёт media-to-s3.yml по
-- маркеру .github/triggers/media-to-s3.json (прогон 24) с чтением обратно.
--
-- ── Что пишет миграция ────────────────────────────────────────────────────
--   • туру — tour_image = обложка, photos = обложка и галерея по порядку, и
--     только туру, у которого снимков нет вовсе: что поставил оператор или
--     администратор, не перетирается;
--   • партнёру — подпись «Лагуна Экспедиция» в gallery_credits для каждого
--     адреса его туров под photos/laguna-expedition/; записанная прежде
--     подпись остаётся.
--
-- Идемпотентна. Повтор ничего не меняет. Исход — WARNING в конце.

WITH v(slug, photos) AS (VALUES
  ('lagexp-vulkany-kamchatki-4-dnya', ARRAY[
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-1.jpg',
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-2.jpg'
   ]::text[]),
  ('lagexp-vulkany-kamchatki-5-dnej', ARRAY[
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-5-dnej-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-5-dnej-1.jpg',
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-5-dnej-2.jpg'
   ]::text[]),
  ('lagexp-kamchatka-na-maksimum-letnij-marshrut', ARRAY[
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-letnij-marshrut-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-letnij-marshrut-1.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-letnij-marshrut-2.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-letnij-marshrut-3.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-letnij-marshrut-4.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-letnij-marshrut-5.jpg'
   ]::text[]),
  ('lagexp-kamchatka-letnij-ekspress', ARRAY[
     '/api/images/s3/photos/laguna-expedition/kamchatka-letnij-ekspress-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-letnij-ekspress-1.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-letnij-marshrut-3.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-letnij-ekspress-3.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-letnij-ekspress-4.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-letnij-ekspress-5.jpg'
   ]::text[]),
  ('lagexp-kamchatka-na-maksimum-zimnij-marshrut', ARRAY[
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-zimnij-marshrut-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-zimnij-marshrut-1.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-zimnij-marshrut-2.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-zimnij-marshrut-3.jpg',
     '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-zimnij-marshrut-4.jpg',
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-5-dnej-2.jpg'
   ]::text[]),
  ('lagexp-vulkany-kamchatki-4-dnya-novogodnie-prazdniki', ARRAY[
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-novogodnie-prazdniki-cover.jpg',
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-novogodnie-prazdniki-1.jpg',
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-novogodnie-prazdniki-2.jpg',
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-novogodnie-prazdniki-3.jpg',
     '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-novogodnie-prazdniki-4.jpg'
   ]::text[])
)
UPDATE operator_tours t
   SET photos = v.photos,
       tour_image = v.photos[1],
       updated_at = NOW()
  FROM v, partners p
 WHERE t.slug = v.slug
   AND p.slug = 'laguna-expedition'
   AND p.id::text = t.operator_id::text
   AND NULLIF(btrim(t.tour_image), '') IS NULL
   AND NOT EXISTS (SELECT 1 FROM unnest(t.photos) AS x(u) WHERE NULLIF(btrim(x.u), '') IS NOT NULL);

-- Подпись снимков: каждый адрес набора, стоящий у туров партнёра. Записанное
-- прежде (в том числе другая подпись того же адреса) — справа и побеждает.
UPDATE partners p
   SET gallery_credits = s.merged,
       updated_at = NOW()
  FROM (
    SELECT p2.id,
           COALESCE((
             SELECT jsonb_object_agg(u.url, 'Лагуна Экспедиция')
               FROM (SELECT DISTINCT x.url
                       FROM operator_tours t, unnest(t.photos) AS x(url)
                      WHERE t.operator_id::text = p2.id::text
                        AND x.url LIKE '/api/images/s3/photos/laguna-expedition/%') u
           ), '{}'::jsonb) || COALESCE(p2.gallery_credits, '{}'::jsonb) AS merged
      FROM partners p2
     WHERE p2.slug = 'laguna-expedition'
  ) s
 WHERE p.id::text = s.id::text
   AND s.merged IS DISTINCT FROM COALESCE(p.gallery_credits, '{}'::jsonb);

-- Исход вслух: у шести туров 1413 обложка из этого набора. Иное (карточки
-- нет, тура нет, снимки поставил кто-то другой) называется, а не молчит.
DO $$
DECLARE
  v_p    int;
  v_ours int;
BEGIN
  SELECT count(*) INTO v_p FROM partners WHERE slug = 'laguna-expedition';
  IF v_p <> 1 THEN
    RAISE WARNING '[1414] карточек laguna-expedition: % (нужна одна, её заводит 1323) — снимки не поставлены', v_p;
    RETURN;
  END IF;
  SELECT count(*) INTO v_ours
    FROM operator_tours t JOIN partners p ON p.id::text = t.operator_id::text
   WHERE p.slug = 'laguna-expedition' AND t.deleted_at IS NULL
     AND t.source_url ~ '/tours/(36212|36214|37577|37584|41610|51446)-'
     AND t.tour_image LIKE '/api/images/s3/photos/laguna-expedition/%';
  IF v_ours <> 6 THEN
    RAISE WARNING '[1414] у новых туров «Лагуны Экспедиции» % из 6 со снимками этого набора (тура нет — 1413 не прошла, или снимки уже поставил кто-то другой)', v_ours;
  END IF;
END $$;
