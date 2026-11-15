-- 1446: весь альбом гида «Горелый» у тура «Восхождение на вулкан Горелый» (1338).
--
-- Основание. Владелец 15.11: «адаптируй все его фото и видео и помнишь что
-- все должно быть в s3» — об альбоме гида в Google Фото «Горелый». Согласие
-- гида на материалы записано: он подписал его сам 29.10
-- (partner_material_consents, 1321).
--
-- Что взято. Альбом (17 снимков, 2 ролика) разобран глазами целиком:
--   • 9 новых снимков — к шести, что стоят у тура с 1338 (пять снимков
--     Горелого и розовый рододендрон); пять снимков альбома и есть те пять,
--     ещё один почти повторяет снимок кальдеры; портрет человека и групповой
--     снимок туристов у машин не взяты (люди главные в кадре, правило 1414);
--   • 3 клипа из второго ролика — к двум из первого (1444); хвост ролика с
--     туристами крупно не взят. Подписи — только то, что видно в кадре: что
--     за провал на дне кратера и что озеро кислотное, по кадру не установить
--     (§4.0).
-- Снимки пережаты до 1600 px, метаданные и место съёмки сняты, копии
-- .320/.640/.1280.webp лежат рядом; клипы — 540×960, H.264, 8 с, без звука.
-- Всё залито в хранилище workflow media-to-s3.yml по маркеру (прогон 27, с
-- чтением обратно) прежде этой миграции (§4.1).
--
-- Что пишет миграция:
--   • туру — снимки ДОПИСЫВАЮТСЯ после тех, что уже стоят (свои снимки гида и
--     обложка не трогаются), тот же адрес не дублируется;
--   • туру — клипы дописываются так же, как в 1444: свои ролики гида первыми,
--     тот же ключ не дублируется, всего не больше восьми (MAX_TOUR_CLIPS);
--   • гиду — подпись автора к каждому новому адресу в gallery_credits. Подпись
--     берётся у снимка, который стоит у тура первым: альбом тот же, автор тот
--     же. Подписи у первого снимка нет — новой подписи тоже нет: имя автора
--     миграция не придумывает. Записанная прежде подпись остаётся.
-- Тура нет — ничего не меняется. Повтор ничего не меняет.

WITH tour AS (
  SELECT t.id, t.operator_id, t.photos
    FROM operator_tours t
   WHERE t.slug = 'zaporozhets-vulkan-gorelyy'
     AND t.deleted_at IS NULL
),
new_photos(url, n) AS (
  SELECT url, n FROM unnest(ARRAY[
    '/api/images/s3/photos/zaporozhets/gorely-crater-turquoise-lakes.jpg',
    '/api/images/s3/photos/zaporozhets/gorely-crater-lakes-vertical.jpg',
    '/api/images/s3/photos/zaporozhets/gorely-crater-depth.jpg',
    '/api/images/s3/photos/zaporozhets/gorely-ice-lake-vertical.jpg',
    '/api/images/s3/photos/zaporozhets/gorely-lava-cave.jpg',
    '/api/images/s3/photos/zaporozhets/gorely-cave-ladder.jpg',
    '/api/images/s3/photos/zaporozhets/gorely-distant-cone.jpg',
    '/api/images/s3/photos/zaporozhets/gorely-rhododendron.jpg',
    '/api/images/s3/photos/zaporozhets/gorely-animal-on-rock.jpg'
  ]::text[]) WITH ORDINALITY AS x(url, n)
),
missing_photos AS (
  SELECT t.id, array_agg(np.url ORDER BY np.n) AS urls
    FROM tour t
    JOIN new_photos np ON NOT (np.url = ANY (COALESCE(t.photos, '{}'::text[])))
   GROUP BY t.id
)
UPDATE operator_tours ot
   SET photos = COALESCE(ot.photos, '{}'::text[]) || mp.urls,
       updated_at = NOW()
  FROM missing_photos mp
 WHERE ot.id::text = mp.id::text;

WITH tour AS (
  SELECT t.operator_id, t.photos
    FROM operator_tours t
   WHERE t.slug = 'zaporozhets-vulkan-gorelyy'
     AND t.deleted_at IS NULL
),
author AS (
  SELECT p.id, NULLIF(btrim(p.gallery_credits ->> t.photos[1]), '') AS credit
    FROM tour t
    JOIN partners p ON p.id::text = t.operator_id::text
),
added AS (
  SELECT a.id, jsonb_object_agg(u.url, a.credit) AS credits
    FROM author a
    CROSS JOIN unnest(ARRAY[
      '/api/images/s3/photos/zaporozhets/gorely-crater-turquoise-lakes.jpg',
      '/api/images/s3/photos/zaporozhets/gorely-crater-lakes-vertical.jpg',
      '/api/images/s3/photos/zaporozhets/gorely-crater-depth.jpg',
      '/api/images/s3/photos/zaporozhets/gorely-ice-lake-vertical.jpg',
      '/api/images/s3/photos/zaporozhets/gorely-lava-cave.jpg',
      '/api/images/s3/photos/zaporozhets/gorely-cave-ladder.jpg',
      '/api/images/s3/photos/zaporozhets/gorely-distant-cone.jpg',
      '/api/images/s3/photos/zaporozhets/gorely-rhododendron.jpg',
      '/api/images/s3/photos/zaporozhets/gorely-animal-on-rock.jpg'
    ]::text[]) AS u(url)
   WHERE a.credit IS NOT NULL
   GROUP BY a.id
)
UPDATE partners p
   SET gallery_credits = ad.credits || COALESCE(p.gallery_credits, '{}'::jsonb),
       updated_at = NOW()
  FROM added ad
 WHERE p.id::text = ad.id::text
   AND ad.credits || COALESCE(p.gallery_credits, '{}'::jsonb) IS DISTINCT FROM COALESCE(p.gallery_credits, '{}'::jsonb);

WITH clips(c, n) AS (
  SELECT c, n FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('key', 'videos/zaporozhets/clip-gorely-sulfur-pit.mp4',
                       'poster', 'videos/zaporozhets/clip-gorely-sulfur-pit.poster.jpg',
                       'label', 'Тёмный провал и сера на дне кратера'),
    jsonb_build_object('key', 'videos/zaporozhets/clip-gorely-fumarole-steam.mp4',
                       'poster', 'videos/zaporozhets/clip-gorely-fumarole-steam.poster.jpg',
                       'label', 'Пар над фумаролами в кратере'),
    jsonb_build_object('key', 'videos/zaporozhets/clip-gorely-layered-walls.mp4',
                       'poster', 'videos/zaporozhets/clip-gorely-layered-walls.poster.jpg',
                       'label', 'Слоистые стены кратера')
  )) WITH ORDINALITY AS x(c, n)
),
missing AS (
  SELECT t.id, cl.c, cl.n,
         jsonb_array_length(t.video_clips) AS have,
         row_number() OVER (PARTITION BY t.id ORDER BY cl.n) AS k
    FROM operator_tours t
    CROSS JOIN clips cl
   WHERE t.slug = 'zaporozhets-vulkan-gorelyy'
     AND t.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(t.video_clips) e
        WHERE e->>'key' = cl.c->>'key'
     )
),
additions AS (
  SELECT id, jsonb_agg(c ORDER BY n) AS items
    FROM missing
   WHERE k <= 8 - have
   GROUP BY id
)
UPDATE operator_tours ot
   SET video_clips = ot.video_clips || a.items,
       updated_at = NOW()
  FROM additions a
 WHERE ot.id::text = a.id::text;
