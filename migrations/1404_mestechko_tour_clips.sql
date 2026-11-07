-- 1404: клипы у туров «Местечка Камчатка» — ролики со страниц их туров.
--
-- Повод. Владелец 07.11: «я посмотрел туры Андрея Запорожца, там есть видео,
-- а у Местечко нет, хотя на сайте у них должно быть». На сайте оператора
-- (mestechkokam.ru) у 16 из 18 страниц туров в шапке крутится свой короткий
-- ролик (слайдер, data-mp4); у снегоходных туров роликов нет.
--
-- Основание. Те же туры оператор разрешил разместить своим «ДА» (1217), и
-- снимки с этих страниц уже стоят в галереях его туров (та же 1217).
-- Ролики — его же материал с его же страниц, и показываются только на его
-- турах, то есть на его витрине. На карточки мест они не идут: туда снимки
-- «Местечка» сняты до согласия (1263).
--
-- Что за клипы. Ролик взят целиком (3–10 с), вертикаль 400×710, как в
-- источнике, без увеличения; H.264, без звука, метаданные сняты. Файлы лежат
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

WITH clips(slug, c) AS (
  VALUES
    ('mestechko-ozero-tolmachevo',
     jsonb_build_object('key', 'videos/mestechko/clip-ozero-tolmachevo.mp4',
                        'poster', 'videos/mestechko/clip-ozero-tolmachevo.poster.jpg',
                        'label', 'Озеро в чаше гор с высоты')),
    ('mestechko-dachnye-istochniki',
     jsonb_build_object('key', 'videos/mestechko/clip-dachnye-istochniki.mp4',
                        'poster', 'videos/mestechko/clip-dachnye-istochniki.poster.jpg',
                        'label', 'Пар над источниками в долине')),
    ('mestechko-vachkazhets',
     jsonb_build_object('key', 'videos/mestechko/clip-vachkazhets.mp4',
                        'poster', 'videos/mestechko/clip-vachkazhets.poster.jpg',
                        'label', 'Водопад и снежник в ущелье')),
    ('mestechko-mys-mayachnyy',
     jsonb_build_object('key', 'videos/mestechko/clip-mys-mayachnyy.mp4',
                        'poster', 'videos/mestechko/clip-mys-mayachnyy.poster.jpg',
                        'label', 'Скалы и прибой на берегу океана')),
    ('mestechko-buhta-russkaya',
     jsonb_build_object('key', 'videos/mestechko/clip-buhta-russkaya.mp4',
                        'poster', 'videos/mestechko/clip-buhta-russkaya.poster.jpg',
                        'label', 'Косатка в бухте')),
    ('mestechko-ostrov-starichkov',
     jsonb_build_object('key', 'videos/mestechko/clip-ostrov-starichkov.mp4',
                        'poster', 'videos/mestechko/clip-ostrov-starichkov.poster.jpg',
                        'label', 'Сивучи на камне у воды')),
    ('mestechko-dolina-geyzerov-tolbachik',
     jsonb_build_object('key', 'videos/mestechko/clip-dolina-geyzerov-tolbachik.mp4',
                        'poster', 'videos/mestechko/clip-dolina-geyzerov-tolbachik.poster.jpg',
                        'label', 'Кипящий грязевой котёл')),
    ('mestechko-oblet-koryakskiy-avachinskiy',
     jsonb_build_object('key', 'videos/mestechko/clip-oblet-koryakskiy.mp4',
                        'poster', 'videos/mestechko/clip-oblet-koryakskiy.poster.jpg',
                        'label', 'Над кратером вулкана с вертолёта')),
    ('mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy',
     jsonb_build_object('key', 'videos/mestechko/clip-oblet-vilyuchinskiy.mp4',
                        'poster', 'videos/mestechko/clip-oblet-vilyuchinskiy.poster.jpg',
                        'label', 'Склон со снежником и горы в облаках')),
    ('mestechko-kurilskoe-ozero',
     jsonb_build_object('key', 'videos/mestechko/clip-kurilskoe-ozero.mp4',
                        'poster', 'videos/mestechko/clip-kurilskoe-ozero.poster.jpg',
                        'label', 'Медведь на берегу озера')),
    ('mestechko-vertolet-tolbachik',
     jsonb_build_object('key', 'videos/mestechko/clip-vertolet-tolbachik.mp4',
                        'poster', 'videos/mestechko/clip-vertolet-tolbachik.poster.jpg',
                        'label', 'Вершина вулкана с вертолёта'))
),
missing AS (
  SELECT t.id, cl.c, jsonb_array_length(t.video_clips) AS have
    FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'mestechko'
    JOIN clips cl ON cl.slug = t.slug
   WHERE t.deleted_at IS NULL
     AND jsonb_array_length(t.video_clips) < 8
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(t.video_clips) e
        WHERE e->>'key' = cl.c->>'key'
     )
)
UPDATE operator_tours ot
   SET video_clips = ot.video_clips || jsonb_build_array(m.c),
       updated_at = NOW()
  FROM missing m
 WHERE ot.id::text = m.id::text;
