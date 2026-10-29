-- 1340: лента клипов у туров гида «Курильское озеро на внедорожнике», 3 и 4 дня
-- (миграция 1338).
--
-- Основание. Гид прислал владельцу альбом «Курильское видео»; владелец 28.10:
-- «фото согласие он мне дал», 29.10: «красиво нужно делать и видео круто».
-- Записанного согласия партнёра на материалы (partner_material_consents, 1321)
-- пока нет — гид подписывает его сам; до тех пор основание — слово владельца,
-- как у снимков 1338.
--
-- Что за клипы. Из 18 роликов альбома отобрано шесть отрезков по 8 секунд:
-- вертикаль 9:16, 540×960, без звука, метаданные сняты (в роликах телефона
-- бывает место съёмки). Отрезков с лицами туристов нет: ролики, где человек
-- стоит лицом к камере, в ленту не взяты. Ролик с вертолётом над озером тоже
-- не взят — тур идёт на внедорожнике, и вертолёт в его ленте читался бы как
-- обещание полёта. Подписи называют только то, что видно в кадре: вид рыбы
-- («нерка») и имя вулкана не названы — по кадру их не установить (§4.0).
-- «Кутхины Баты» названы: столбы узнаваемы и стоят в программе обоих туров.
--
-- Файлы лежат в media/s3/videos/zaporozhets/ и заливаются в хранилище
-- workflow media-to-s3.yml по маркеру (прогон 16) с чтением обратно; в базе —
-- ключи, адрес собирает сервер (lib/tours/tour-clips.ts). Автор под лентой —
-- продавец тура («Видео: …», components/tours/TourClips).
--
-- Только туда, где список пуст: клипы, поставленные гидом или менеджером,
-- миграция не затирает. Тура нет — ничего не меняется. Повтор ничего не
-- меняет.

UPDATE operator_tours ot
   SET video_clips = jsonb_build_array(
         jsonb_build_object('key', 'videos/zaporozhets/clip-bear-fish.mp4',
                            'poster', 'videos/zaporozhets/clip-bear-fish.poster.jpg',
                            'label', 'Медведь поймал рыбу'),
         jsonb_build_object('key', 'videos/zaporozhets/clip-kuthiny-baty.mp4',
                            'poster', 'videos/zaporozhets/clip-kuthiny-baty.poster.jpg',
                            'label', 'Кутхины Баты: пемзовые столбы'),
         jsonb_build_object('key', 'videos/zaporozhets/clip-cubs-snag.mp4',
                            'poster', 'videos/zaporozhets/clip-cubs-snag.poster.jpg',
                            'label', 'Медвежата возятся у коряги'),
         jsonb_build_object('key', 'videos/zaporozhets/clip-seals-spit.mp4',
                            'poster', 'videos/zaporozhets/clip-seals-spit.poster.jpg',
                            'label', 'Тюлени на песчаной косе'),
         jsonb_build_object('key', 'videos/zaporozhets/clip-red-fish.mp4',
                            'poster', 'videos/zaporozhets/clip-red-fish.poster.jpg',
                            'label', 'Красная рыба в прозрачной воде'),
         jsonb_build_object('key', 'videos/zaporozhets/clip-two-bears.mp4',
                            'poster', 'videos/zaporozhets/clip-two-bears.poster.jpg',
                            'label', 'Два медведя на галечном берегу')
       ),
       updated_at = NOW()
 WHERE ot.slug IN ('zaporozhets-kurilskoe-ozero-3-dnya', 'zaporozhets-kurilskoe-ozero-4-dnya')
   AND ot.video_clips = '[]'::jsonb;
