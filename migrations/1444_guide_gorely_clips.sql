-- 1444: лента клипов у тура гида «Восхождение на вулкан Горелый» (миграция 1338).
--
-- Основание. Владелец 15.11: «Горелый: <альбом гида в Google Фото>» и «я
-- скачал видео, которое просил Андрей вставить в Горелый» — о ролике из
-- того же альбома. Согласие гида на материалы записано: он подписал его сам
-- 29.10 (partner_material_consents, 1321).
--
-- Что за клипы. Из одного ролика альбома «Горелый» (22 с, вертикаль) — два
-- отрезка по 8 с: красный шлак, снежник и горы вдали; бирюзовое озеро со
-- льдом в кратере. Вертикаль 540×960, H.264, без звука, метаданные и место
-- съёмки сняты. Людей в кадре нет (на гребне кратера и у машин вдали —
-- точки, лиц не различить). Подписи — только то, что видно в кадре: что
-- озеро кислотное и как называются вершины вдали, по кадру не установить
-- (§4.0).
--
-- Файлы лежат в media/s3/videos/zaporozhets/ и залиты в хранилище workflow
-- media-to-s3.yml по маркеру (прогон 26, Actions 43701154328 — успех, все
-- четыре объекта прочитаны обратно) прежде этой миграции: сайт не
-- переключается на объекты в том же выкате, в котором они впервые
-- заливаются (§4.1). В базе — ключи, адрес собирает сервер
-- (lib/tours/tour-clips.ts).
--
-- Клипы ДОПИСЫВАЮТСЯ к тому, что уже стоит у тура (порядок 1398): свои ролики
-- гида из кабинета остаются первыми и не затираются, тот же ключ не
-- дублируется, всего не больше восьми (MAX_TOUR_CLIPS). Тура нет — ничего не
-- меняется. Повтор ничего не меняет.

WITH clips(c, n) AS (
  SELECT c, n FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('key', 'videos/zaporozhets/clip-gorely-slope-peaks.mp4',
                       'poster', 'videos/zaporozhets/clip-gorely-slope-peaks.poster.jpg',
                       'label', 'Красный шлак, снежник и горы вдали'),
    jsonb_build_object('key', 'videos/zaporozhets/clip-gorely-crater-lake.mp4',
                       'poster', 'videos/zaporozhets/clip-gorely-crater-lake.poster.jpg',
                       'label', 'Бирюзовое озеро со льдом в кратере')
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
