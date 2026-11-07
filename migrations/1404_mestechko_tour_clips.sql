-- 1404: клипы у туров «Местечка Камчатка» — ролики со страниц их туров.
--
-- Повод. Владелец 07.11: «я посмотрел туры Андрея Запорожца, там есть видео,
-- а у Местечко нет, хотя на сайте у них должно быть», затем «у них тг канал
-- еще». На сайте оператора (mestechkokam.ru) у 16 из 18 страниц туров в шапке
-- крутится свой короткий ролик (слайдер, data-mp4); у снегоходных туров
-- роликов нет. В публичной ленте их канала t.me/mestechko_kamchatka — 50
-- роликов в 33 постах.
--
-- Основание. Те же туры оператор разрешил разместить своим «ДА» (1217), и
-- снимки с этих страниц уже стоят в галереях его туров (та же 1217).
-- Ролики — его же материал с его же страниц и из его канала, и показываются
-- только на его турах, то есть на его витрине. На карточки мест они не идут: туда снимки
-- «Местечка» сняты до согласия (1263).
--
-- Что за клипы. С сайта — ролик целиком (3–10 с), вертикаль 400×710, как в
-- источнике, без увеличения. Из канала — отрезки 4–8 с без людей в кадре, без
-- надписей поверх и без заставки с логотипом, 540×960 (источник 720×1280):
--   • пост 208 (14.08.2024, «вертолётная экскурсия в царство медведей») —
--     медведи у воды, медведь на бревне, медведь у деревянного настила —
--     туру «Курильское озеро»;
--   • пост 149 (09.04.2024, «Бухта Русская») — косатки с дрона, отрезок
--     без людей на палубе — туру «Бухта Русская»;
--   • пост 244 (02.04.2025, «Облёт вулканов Корякский, Авачинский») —
--     вулкан над облаками с вертолёта — туру облёта.
-- Посты с людьми в лицо, мемами, надписями поверх кадра, рекламными
-- карточками, выставкой и автопарком (номера машин) не взяты. Всё — H.264,
-- без звука, метаданные сняты. Файлы лежат
-- в media/s3/videos/mestechko/ и заливаются в хранилище workflow
-- media-to-s3.yml по маркеру (прогон 19) с чтением обратно; в базе — ключи,
-- адрес собирает сервер (lib/tours/tour-clips.ts). Подписи — только то, что
-- видно в кадре.
--
-- Каждый ролик сверен с туром глазами (07.11), и ставятся не все:
--   • tolm.mp4 сайт показывает у трёх туров — «Озеро Толмачёва»,
--     «Халактырский пляж» и «Толбачик (джип-тур)». В кадре — озеро в чаше
--     гор: это тур Толмачёва. Пляжу и Толбачику он не ставится — показать
--     туристу не то место значило бы пообещать другую поездку;
--   • «Авачинский перевал»: на всём ролике читается номер машины, а с первых
--     секунд в кадре человек на крыше. Размытая полоса закрывала полмашины —
--     клип не ставится;
--   • «Вулкан Горелый» и «Долина гейзеров (вертолёт)»: ролики горизонтальные,
--     580×326, и в вертикальной рамке карточки вышли бы мутной вырезкой — не
--     ставятся;
--   • снегоходные туры — роликов на сайте нет.
--
-- Клипы ДОПИСЫВАЮТСЯ к тому, что уже стоит у тура: свои ролики оператора из
-- кабинета остаются первыми и не затираются. Уже стоящий клип с тем же
-- ключом не дублируется, и всего клипов не больше восьми (MAX_TOUR_CLIPS,
-- lib/tours/clip-limit.ts). Тура нет — ничего не меняется. Повтор ничего не
-- меняет.
--
-- IDEMPOTENT

WITH clips(slug, n, c) AS (
  VALUES
    ('mestechko-ozero-tolmachevo', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-ozero-tolmachevo.mp4',
                        'poster', 'videos/mestechko/clip-ozero-tolmachevo.poster.jpg',
                        'label', 'Озеро в чаше гор с высоты')),
    ('mestechko-dachnye-istochniki', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-dachnye-istochniki.mp4',
                        'poster', 'videos/mestechko/clip-dachnye-istochniki.poster.jpg',
                        'label', 'Пар над источниками в долине')),
    ('mestechko-vachkazhets', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-vachkazhets.mp4',
                        'poster', 'videos/mestechko/clip-vachkazhets.poster.jpg',
                        'label', 'Водопад и снежник в ущелье')),
    ('mestechko-mys-mayachnyy', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-mys-mayachnyy.mp4',
                        'poster', 'videos/mestechko/clip-mys-mayachnyy.poster.jpg',
                        'label', 'Скалы и прибой на берегу океана')),
    ('mestechko-buhta-russkaya', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-buhta-russkaya.mp4',
                        'poster', 'videos/mestechko/clip-buhta-russkaya.poster.jpg',
                        'label', 'Косатка в бухте')),
    ('mestechko-buhta-russkaya', 2,
     jsonb_build_object('key', 'videos/mestechko/clip-buhta-russkaya-orcas.mp4',
                        'poster', 'videos/mestechko/clip-buhta-russkaya-orcas.poster.jpg',
                        'label', 'Косатки сверху')),
    ('mestechko-ostrov-starichkov', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-ostrov-starichkov.mp4',
                        'poster', 'videos/mestechko/clip-ostrov-starichkov.poster.jpg',
                        'label', 'Сивучи на камне у воды')),
    ('mestechko-dolina-geyzerov-tolbachik', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-dolina-geyzerov-tolbachik.mp4',
                        'poster', 'videos/mestechko/clip-dolina-geyzerov-tolbachik.poster.jpg',
                        'label', 'Кипящий грязевой котёл')),
    ('mestechko-oblet-koryakskiy-avachinskiy', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-oblet-koryakskiy.mp4',
                        'poster', 'videos/mestechko/clip-oblet-koryakskiy.poster.jpg',
                        'label', 'Над кратером вулкана с вертолёта')),
    ('mestechko-oblet-koryakskiy-avachinskiy', 2,
     jsonb_build_object('key', 'videos/mestechko/clip-oblet-volcano-clouds.mp4',
                        'poster', 'videos/mestechko/clip-oblet-volcano-clouds.poster.jpg',
                        'label', 'Вулкан над облаками с вертолёта')),
    ('mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-oblet-vilyuchinskiy.mp4',
                        'poster', 'videos/mestechko/clip-oblet-vilyuchinskiy.poster.jpg',
                        'label', 'Склон со снежником и горы в облаках')),
    ('mestechko-kurilskoe-ozero', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-kurilskoe-ozero.mp4',
                        'poster', 'videos/mestechko/clip-kurilskoe-ozero.poster.jpg',
                        'label', 'Медведь на берегу озера')),
    ('mestechko-kurilskoe-ozero', 2,
     jsonb_build_object('key', 'videos/mestechko/clip-kurile-bears-water.mp4',
                        'poster', 'videos/mestechko/clip-kurile-bears-water.poster.jpg',
                        'label', 'Медведи у воды')),
    ('mestechko-kurilskoe-ozero', 3,
     jsonb_build_object('key', 'videos/mestechko/clip-kurile-bear-log.mp4',
                        'poster', 'videos/mestechko/clip-kurile-bear-log.poster.jpg',
                        'label', 'Медведь на бревне у воды')),
    ('mestechko-kurilskoe-ozero', 4,
     jsonb_build_object('key', 'videos/mestechko/clip-kurile-bear-boardwalk.mp4',
                        'poster', 'videos/mestechko/clip-kurile-bear-boardwalk.poster.jpg',
                        'label', 'Медведь у деревянного настила')),
    ('mestechko-vertolet-tolbachik', 1,
     jsonb_build_object('key', 'videos/mestechko/clip-vertolet-tolbachik.mp4',
                        'poster', 'videos/mestechko/clip-vertolet-tolbachik.poster.jpg',
                        'label', 'Вершина вулкана с вертолёта'))
),
missing AS (
  SELECT t.id, cl.c, cl.n,
         jsonb_array_length(t.video_clips) AS have,
         row_number() OVER (PARTITION BY t.id ORDER BY cl.n) AS k
    FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'mestechko'
    JOIN clips cl ON cl.slug = t.slug
   WHERE t.deleted_at IS NULL
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
