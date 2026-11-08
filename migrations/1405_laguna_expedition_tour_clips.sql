-- 1405: клипы у туров «Лагуны Экспедиции» — из роликов её сайта и её канала.
--
-- Повод. Владелец 07.11, после клипов «Местечка» (1404): «лагуна экспедиция
-- и вулканы камчатки так же с видео и у них тоже есть тг». У 34 туров «Лагуны
-- Экспедиции» (1339) видео не было вовсе.
--
-- Основание. Материалы с сайта оператора партнёр разрешил: слово владельца
-- 29.10 «они дали добро на использование» — по нему 1343 взяла снимки и
-- логотип. Ролики — тот же материал оператора с его же сайта и из его же
-- канала, и показываются только на его турах, то есть на его витрине.
-- Записанного согласия (partner_material_consents, 1321) пока нет — это тот
-- же открытый пункт, что назван в 1343.
--
-- Источники.
--   • laguna-expedition.ru, главная (снято 07.11): восемь горизонтальных
--     роликов 1080p по 80–127 с из блока «Видео блог» и шапки — «Мыс Маячный +
--     Халактырский пляж», «Лавовые пещеры вулкана Горелый + водопад Снежный
--     барс», «Маар + озеро», «Опасный + источники», «День 1/2/3» зимнего тура
--     и зимняя заставка. Из них вырезаны вертикальные отрезки 540×960 (заставка
--     720p — 404×720): клип собран из двух-трёх соседних планов ОДНОГО места,
--     окно 9:16 подобрано для каждого плана, знак «ЛАГУНА» в углу кадра в
--     окно не попадает;
--   • t.me/laguna_expedition: пост 878 (26.10, «Халактырский пляж») и пост 861
--     (12.10, маршрут «Вилючинский перевал — Дачные источники»).
-- Взяты только планы без людей. Туристы в кадре крупно, группы, люди у
-- водопада и на краю каньона, номера машин, надписи поверх кадра и заставки
-- с логотипом — нет. Всё — H.264, без звука, метаданные сняты. Файлы — в
-- media/s3/videos/lagexp/, заливка — media-to-s3.yml, прогон 20, с чтением
-- обратно; в базе — ключи, адрес собирает сервер (lib/tours/tour-clips.ts).
-- Подписи — только то, что видно в кадре.
--
-- Клип ставится туру, только если место в кадре названо в программе тура и
-- сезон совпадает (тот же порядок, что у снимков в 1343: кадр не обещает
-- того, чего в программе нет):
--   • Три брата, маяк — туры на мыс Маячный («На край света», «Мыс Маячный +
--     Халактырский пляж»). Зимнему «За снегоходом на Мыс Маячный» осенний
--     кадр не ставится;
--   • волны и берег Халактыра — «Мыс Маячный + Халактырский пляж»,
--     «Халактырский пляж» (черновик 1339 — клип ему не вредит и опубликуется
--     вместе с ним), сити-тур (в его программе — пикник на Халактыре);
--   • зимний прибой — «День 2» зимнего тура (город + Халактыр): сити-тур и оба
--     «Новогодних вулкана», где Халактыр стоит днём 2. «Новому году на
--     Камчатке» не ставится: там Халактыр — только замена по погоде;
--   • водопад «Снежный барс» — оба тура к водопаду; лавовые пещеры Горелого из
--     того же ролика не ставятся никому — пещер нет ни в одной программе;
--   • каньон Опасный — оба тура в каньон; фумаролы и пар Дачных — туры к
--     Дачным источникам и «Каньон Опасный + Дачные»;
--   • вулкан над долиной (начало ролика «Опасный», дорога через Вилючинский
--     перевал) — оба тура «К Гамулам на Вилючинский перевал»;
--   • озеро с песчаной косой — «Камчатка на максимум: осенний маршрут» (день
--     4, озеро Толмачёва). Кратер маара из того же ролика не ставится — маара
--     нет в программе;
--   • снежное плато, Корякский и Авачинский, снегоход с нартой вдали — «Два
--     вулкана (Авачинский перевал) в снегоходной нарте».
-- Не ставятся и «День 1» (вездеход к источнику — какой это источник, ролик не
-- говорит) и «День 3» (стойбище и упряжки — чьё это хозяйство, неизвестно, а
-- катание на упряжке есть не во всех программах): чужое место показало бы
-- туристу другую поездку. Медведей и евражек из канала тоже нет: где сняты,
-- посты не говорят, а встреча со зверем программой не обещана.
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
    ('lagexp-mys-mayachnyj-khalaktyrskij-plyazh', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-tri-brata.mp4',
                        'poster', 'videos/lagexp/clip-tri-brata.poster.jpg',
                        'label', 'Скалы «Три брата» в бухте')),
    ('lagexp-mys-mayachnyj-khalaktyrskij-plyazh', 2,
     jsonb_build_object('key', 'videos/lagexp/clip-mayak.mp4',
                        'poster', 'videos/lagexp/clip-mayak.poster.jpg',
                        'label', 'Маяк на мысе')),
    ('lagexp-mys-mayachnyj-khalaktyrskij-plyazh', 3,
     jsonb_build_object('key', 'videos/lagexp/clip-khalaktyr-volny.mp4',
                        'poster', 'videos/lagexp/clip-khalaktyr-volny.poster.jpg',
                        'label', 'Волны на чёрном песке с высоты')),
    ('lagexp-mys-mayachnyj-khalaktyrskij-plyazh', 4,
     jsonb_build_object('key', 'videos/lagexp/clip-khalaktyr-bereg.mp4',
                        'poster', 'videos/lagexp/clip-khalaktyr-bereg.poster.jpg',
                        'label', 'Прибой и чёрный песок')),
    ('lagexp-na-kraj-sveta-mys-mayachnyj', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-tri-brata.mp4',
                        'poster', 'videos/lagexp/clip-tri-brata.poster.jpg',
                        'label', 'Скалы «Три брата» в бухте')),
    ('lagexp-na-kraj-sveta-mys-mayachnyj', 2,
     jsonb_build_object('key', 'videos/lagexp/clip-mayak.mp4',
                        'poster', 'videos/lagexp/clip-mayak.poster.jpg',
                        'label', 'Маяк на мысе')),
    ('lagexp-khalaktyrskij-plyazh', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-khalaktyr-volny.mp4',
                        'poster', 'videos/lagexp/clip-khalaktyr-volny.poster.jpg',
                        'label', 'Волны на чёрном песке с высоты')),
    ('lagexp-khalaktyrskij-plyazh', 2,
     jsonb_build_object('key', 'videos/lagexp/clip-khalaktyr-bereg.mp4',
                        'poster', 'videos/lagexp/clip-khalaktyr-bereg.poster.jpg',
                        'label', 'Прибой и чёрный песок')),
    ('lagexp-siti-tur-tuda-gde-vstaet-solntse', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-khalaktyr-bereg.mp4',
                        'poster', 'videos/lagexp/clip-khalaktyr-bereg.poster.jpg',
                        'label', 'Прибой и чёрный песок')),
    ('lagexp-siti-tur-tuda-gde-vstaet-solntse', 2,
     jsonb_build_object('key', 'videos/lagexp/clip-khalaktyr-zima.mp4',
                        'poster', 'videos/lagexp/clip-khalaktyr-zima.poster.jpg',
                        'label', 'Зимний прибой на чёрном песке')),
    ('lagexp-novogodnie-vulkany-kamchatki-laguna-4', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-khalaktyr-zima.mp4',
                        'poster', 'videos/lagexp/clip-khalaktyr-zima.poster.jpg',
                        'label', 'Зимний прибой на чёрном песке')),
    ('lagexp-novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-khalaktyr-zima.mp4',
                        'poster', 'videos/lagexp/clip-khalaktyr-zima.poster.jpg',
                        'label', 'Зимний прибой на чёрном песке')),
    ('lagexp-vodopad-snezhnyj-bars-vilyuchinskij-pereval', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-snezhnyj-bars.mp4',
                        'poster', 'videos/lagexp/clip-snezhnyj-bars.poster.jpg',
                        'label', 'Водопад в ущелье')),
    ('lagexp-vodopad-snezhnyj-bars-vilyuchinskij-pereval', 2,
     jsonb_build_object('key', 'videos/lagexp/clip-snezhnyj-bars-ushchele.mp4',
                        'poster', 'videos/lagexp/clip-snezhnyj-bars-ushchele.poster.jpg',
                        'label', 'Ущелье и водопад с высоты')),
    ('lagexp-vodopad-snezhnyj-bars-vilyuchinskij-pereval-na-vezdekhode-sever-truck', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-snezhnyj-bars.mp4',
                        'poster', 'videos/lagexp/clip-snezhnyj-bars.poster.jpg',
                        'label', 'Водопад в ущелье')),
    ('lagexp-vodopad-snezhnyj-bars-vilyuchinskij-pereval-na-vezdekhode-sever-truck', 2,
     jsonb_build_object('key', 'videos/lagexp/clip-snezhnyj-bars-ushchele.mp4',
                        'poster', 'videos/lagexp/clip-snezhnyj-bars-ushchele.poster.jpg',
                        'label', 'Ущелье и водопад с высоты')),
    ('lagexp-kanon-opasnyj', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-kanon-opasnyj.mp4',
                        'poster', 'videos/lagexp/clip-kanon-opasnyj.poster.jpg',
                        'label', 'Водопад в каньоне')),
    ('lagexp-kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-kanon-opasnyj.mp4',
                        'poster', 'videos/lagexp/clip-kanon-opasnyj.poster.jpg',
                        'label', 'Водопад в каньоне')),
    ('lagexp-kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck', 2,
     jsonb_build_object('key', 'videos/lagexp/clip-dachnye-fumaroly.mp4',
                        'poster', 'videos/lagexp/clip-dachnye-fumaroly.poster.jpg',
                        'label', 'Пар фумарол на склоне')),
    ('lagexp-kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck', 3,
     jsonb_build_object('key', 'videos/lagexp/clip-dachnye-par.mp4',
                        'poster', 'videos/lagexp/clip-dachnye-par.poster.jpg',
                        'label', 'Пар из трещин среди камней')),
    ('lagexp-dachnye-goryachie-istochniki-na-vezdekhode-sever-truck', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-dachnye-fumaroly.mp4',
                        'poster', 'videos/lagexp/clip-dachnye-fumaroly.poster.jpg',
                        'label', 'Пар фумарол на склоне')),
    ('lagexp-dachnye-goryachie-istochniki-na-vezdekhode-sever-truck', 2,
     jsonb_build_object('key', 'videos/lagexp/clip-dachnye-par.mp4',
                        'poster', 'videos/lagexp/clip-dachnye-par.poster.jpg',
                        'label', 'Пар из трещин среди камней')),
    ('lagexp-dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-dachnye-fumaroly.mp4',
                        'poster', 'videos/lagexp/clip-dachnye-fumaroly.poster.jpg',
                        'label', 'Пар фумарол на склоне')),
    ('lagexp-dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300', 2,
     jsonb_build_object('key', 'videos/lagexp/clip-dachnye-par.mp4',
                        'poster', 'videos/lagexp/clip-dachnye-par.poster.jpg',
                        'label', 'Пар из трещин среди камней')),
    ('lagexp-k-gamulam-na-vilyuchinskij-pereval', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-vilyuchinskij.mp4',
                        'poster', 'videos/lagexp/clip-vilyuchinskij.poster.jpg',
                        'label', 'Вулкан над долиной')),
    ('lagexp-k-gamulam-na-vilyuchinskij-pereval-na-vnedorozhnike-tank-300', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-vilyuchinskij.mp4',
                        'poster', 'videos/lagexp/clip-vilyuchinskij.poster.jpg',
                        'label', 'Вулкан над долиной')),
    ('lagexp-kamchatka-na-maksimum-osennij-marshrut', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-ozero-tolmacheva.mp4',
                        'poster', 'videos/lagexp/clip-ozero-tolmacheva.poster.jpg',
                        'label', 'Озеро с песчаной косой')),
    ('lagexp-dva-vulkana-avachinskij-pereval', 1,
     jsonb_build_object('key', 'videos/lagexp/clip-dva-vulkana.mp4',
                        'poster', 'videos/lagexp/clip-dva-vulkana.poster.jpg',
                        'label', 'Снежное плато и вулканы, снегоход вдали'))
),
missing AS (
  SELECT t.id, cl.c, cl.n,
         jsonb_array_length(t.video_clips) AS have,
         row_number() OVER (PARTITION BY t.id ORDER BY cl.n) AS k
    FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
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
