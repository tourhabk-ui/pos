-- 1399: лента клипов курильских туров гида — пар вместо «Двух медведей»,
-- ещё медведь в воде и лошади у внедорожника (миграция 1340).
--
-- Основание. Гид 07.11 попросил добавить в туры по Курильскому озеру видео
-- из папки «Видео курильское»; владелец гиду: «кидай, я загружу». У обоих
-- туров уже стояли шесть клипов 1340 — тогдашний предел ленты. Владелец
-- 07.11: «Пар вместо „Два медведя“» и «подними до 8» — предел ленты теперь
-- восемь (lib/tours/clip-limit.ts). Медведей в ленте и так было три.
--
-- Что за клипы. Три отрезка одного ролика: пар над склоном (5,5 с), медведь
-- бросается в воду (4,6 с), лошади у внедорожника (3,7 с). Вертикаль
-- 540×960, H.264, без звука, метаданные и место съёмки сняты. Лиц в кадре
-- нет. В клипе с лошадьми номер машины размыт во всех кадрах, а первая
-- секунда, где номер мелькал у края кадра, отрезана. Подписи называют только
-- то, что видно: место пара и вид лошадей по кадру не установить (§4.0).
--
-- Файлы лежат в media/s3/videos/zaporozhets/ и заливаются в хранилище
-- workflow media-to-s3.yml по маркеру (прогон 18) с чтением обратно; в базе —
-- ключи, адрес собирает сервер (lib/tours/tour-clips.ts).
--
-- Как меняется список. «Два медведя на галечном берегу» заменяется паром на
-- том же месте; пар уже стоит — «Два медведя» просто убираются. Медведь и
-- лошади дописываются в конец, если их ещё нет и есть место до восьми.
-- Клипы, которые гид поставил или убрал сам в кабинете, остаются как есть.
-- Тура нет — ничего не меняется. Повтор ничего не меняет.

WITH tours AS (
  SELECT t.id, t.video_clips AS clips,
         EXISTS (
           SELECT 1 FROM jsonb_array_elements(t.video_clips) e
            WHERE e->>'key' = 'videos/zaporozhets/clip-kurile-steam.mp4'
         ) AS has_steam
    FROM operator_tours t
   WHERE t.slug IN ('zaporozhets-kurilskoe-ozero-3-dnya', 'zaporozhets-kurilskoe-ozero-4-dnya')
     AND t.deleted_at IS NULL
),
fresh(c, n) AS (
  SELECT c, n FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('key', 'videos/zaporozhets/clip-kurile-steam.mp4',
                       'poster', 'videos/zaporozhets/clip-kurile-steam.poster.jpg',
                       'label', 'Пар над склоном'),
    jsonb_build_object('key', 'videos/zaporozhets/clip-kurile-bear-plunge.mp4',
                       'poster', 'videos/zaporozhets/clip-kurile-bear-plunge.poster.jpg',
                       'label', 'Медведь бросается в воду'),
    jsonb_build_object('key', 'videos/zaporozhets/clip-kurile-horses.mp4',
                       'poster', 'videos/zaporozhets/clip-kurile-horses.poster.jpg',
                       'label', 'Лошади у внедорожника')
  )) WITH ORDINALITY AS x(c, n)
),
swapped AS (
  SELECT t.id,
         COALESCE(
           jsonb_agg(
             CASE WHEN x.e->>'key' = 'videos/zaporozhets/clip-two-bears.mp4'
                  THEN (SELECT f.c FROM fresh f WHERE f.n = 1)
                  ELSE x.e
             END
             ORDER BY x.i
           ) FILTER (
             WHERE x.e IS NOT NULL
               AND NOT (x.e->>'key' = 'videos/zaporozhets/clip-two-bears.mp4' AND t.has_steam)
           ),
           '[]'::jsonb
         ) AS clips
    FROM tours t
    LEFT JOIN LATERAL jsonb_array_elements(t.clips) WITH ORDINALITY AS x(e, i) ON true
   GROUP BY t.id
),
missing AS (
  SELECT s.id, f.c, f.n,
         jsonb_array_length(s.clips) AS have,
         row_number() OVER (PARTITION BY s.id ORDER BY f.n) AS k
    FROM swapped s
    CROSS JOIN fresh f
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(s.clips) e
      WHERE e->>'key' = f.c->>'key'
   )
),
target AS (
  SELECT s.id,
         s.clips || COALESCE((
           SELECT jsonb_agg(m.c ORDER BY m.n)
             FROM missing m
            WHERE m.id::text = s.id::text
              AND m.k <= 8 - m.have
         ), '[]'::jsonb) AS clips
    FROM swapped s
)
UPDATE operator_tours ot
   SET video_clips = tg.clips,
       updated_at = NOW()
  FROM target tg
 WHERE ot.id::text = tg.id::text
   AND ot.video_clips IS DISTINCT FROM tg.clips;
