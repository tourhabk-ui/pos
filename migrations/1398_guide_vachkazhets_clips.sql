-- 1398: лента клипов у тура гида «Вачкажец + озёрки» (миграция 1338).
--
-- Основание. Гид 07.11 прислал владельцу папку «Видео вачкажец» и попросил
-- поставить ролики в тур; владелец: «кидай, я загружу». Основание для показа
-- — слово владельца, как у клипов Курильского (1340): записанного согласия
-- гида на материалы (partner_material_consents, 1321) пока нет.
--
-- Что за клипы. Из трёх роликов папки — три отрезка: водопад (весь ролик,
-- 3,6 с), евражка у норы и евражка вблизи (по 8 с). Вертикаль 540×960,
-- H.264, без звука, метаданные и место съёмки сняты (в двух роликах
-- телефона были координаты). Людей в кадре нет. Подписи — только то, что
-- видно; евражки и водопады названы и в программе тура (1342).
--
-- Файлы лежат в media/s3/videos/zaporozhets/ и заливаются в хранилище
-- workflow media-to-s3.yml по маркеру (прогон 18) с чтением обратно; в базе —
-- ключи, адрес собирает сервер (lib/tours/tour-clips.ts).
--
-- Клипы ДОПИСЫВАЮТСЯ к тому, что уже стоит у тура: свои ролики гида из
-- кабинета остаются первыми и не затираются. Уже стоящий клип с тем же
-- ключом не дублируется, и всего клипов не больше шести (MAX_TOUR_CLIPS):
-- что не помещается, не ставится. Тура нет — ничего не меняется. Повтор
-- ничего не меняет.

WITH clips(c, n) AS (
  SELECT c, n FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('key', 'videos/zaporozhets/clip-vachkazhets-waterfall.mp4',
                       'poster', 'videos/zaporozhets/clip-vachkazhets-waterfall.poster.jpg',
                       'label', 'Водопад на горном склоне'),
    jsonb_build_object('key', 'videos/zaporozhets/clip-vachkazhets-squirrel-burrow.mp4',
                       'poster', 'videos/zaporozhets/clip-vachkazhets-squirrel-burrow.poster.jpg',
                       'label', 'Евражка у норы'),
    jsonb_build_object('key', 'videos/zaporozhets/clip-vachkazhets-squirrel-close.mp4',
                       'poster', 'videos/zaporozhets/clip-vachkazhets-squirrel-close.poster.jpg',
                       'label', 'Евражка вблизи')
  )) WITH ORDINALITY AS x(c, n)
),
missing AS (
  SELECT t.id, cl.c, cl.n,
         jsonb_array_length(t.video_clips) AS have,
         row_number() OVER (PARTITION BY t.id ORDER BY cl.n) AS k
    FROM operator_tours t
    CROSS JOIN clips cl
   WHERE t.slug = 'zaporozhets-vachkazhets-ozerki'
     AND t.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(t.video_clips) e
        WHERE e->>'key' = cl.c->>'key'
     )
),
additions AS (
  SELECT id, jsonb_agg(c ORDER BY n) AS items
    FROM missing
   WHERE k <= 6 - have
   GROUP BY id
)
UPDATE operator_tours ot
   SET video_clips = ot.video_clips || a.items,
       updated_at = NOW()
  FROM additions a
 WHERE ot.id::text = a.id::text;
