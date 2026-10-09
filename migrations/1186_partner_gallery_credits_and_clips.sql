-- 1186: подписи авторов под кадрами партнёра и короткие клипы (перевозчик «Шатун»).
--
-- Владелец 09.10: «Автор Сладченко Виктор Леонидович, согласие есть на
-- публикацию фото» и «сделаем ленивый показ коротких видео красоты и движа».
--
-- ── Подписи авторов ───────────────────────────────────────────────────────
--
-- До сегодня все 23 кадра «Шатуна» шли под одной подписью «Фото: Шатун»
-- (1185). Часть из них снимал другой человек, и подпись «Шатун» под его
-- работой — не пустяк, а неверная атрибуция. Колонка gallery_credits —
-- карта «путь снимка → подпись»; снимка нет в карте — подписью остаётся имя
-- самого партнёра, как раньше.
--
-- Кому приписан какой кадр — по слову владельца и по содержимому, а не по
-- привычке: владелец назвал автора снимков и согласие, но не перечислял
-- номера. Подписью Сладченко В. Л. получили ВОСЕМЬ снимков дикой природы
-- (shatun-16..23: медведи у воды, чайки, туман над берегом, закат над
-- пляжем) — это ровно те, что прислали в первой пачке «с природой» отдельно
-- от снимков машины. Снимки самой вахтовки и салона (shatun-01..15, в том
-- числе три вечерних кадра, присланные вторым сообщением) остаются «Шатун»:
-- кто их снимал, владелец не говорил, и приписывать им автора по догадке
-- значило бы записать то, чего никто не называл (§4.0). Если автор тот же —
-- это одна правка карты ниже, но не по умолчанию.
--
-- ── Клипы ─────────────────────────────────────────────────────────────────
--
-- video_clips — список коротких петель [{url, poster, label}]. Показываются
-- лениво: файл не качается, пока клип не подошёл к экрану, и не играет у тех,
-- кто просил поменьше движения, экономит трафик или без сети (компонент
-- components/media/LazyClip). Три клипа по 8 секунд без звука — вырезки из
-- ролика, присланного владельцем (1185): подход через воду, паром и трос,
-- выход на берег. 160–230 КБ каждый; полный ролик остаётся плеером ниже.
-- Подписи «где снято» нет: в присланном этого нет.
--
-- IDEMPOTENT

BEGIN;

-- gallery уже есть на проде (baseline, тип тот же) — но ни одна миграция её не
-- объявляла, и сторож колонок (sql-phantom-columns) числил чтение partners.gallery
-- долгом. Здесь она объявляется как есть: на проде это пустая операция.
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS gallery         JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS gallery_credits JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS video_clips     JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_gallery_credits_shape') THEN
    ALTER TABLE partners
      ADD CONSTRAINT partners_gallery_credits_shape
      CHECK (jsonb_typeof(gallery_credits) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_video_clips_shape') THEN
    ALTER TABLE partners
      ADD CONSTRAINT partners_video_clips_shape
      CHECK (jsonb_typeof(video_clips) = 'array');
  END IF;
END $$;

-- Подписи — только туда, где карта пуста: чужую правку администратора не
-- затираем.
UPDATE partners
   SET gallery_credits = jsonb_build_object(
         '/images/shatun/shatun-16.jpg', 'Сладченко Виктор Леонидович',
         '/images/shatun/shatun-17.jpg', 'Сладченко Виктор Леонидович',
         '/images/shatun/shatun-18.jpg', 'Сладченко Виктор Леонидович',
         '/images/shatun/shatun-19.jpg', 'Сладченко Виктор Леонидович',
         '/images/shatun/shatun-20.jpg', 'Сладченко Виктор Леонидович',
         '/images/shatun/shatun-21.jpg', 'Сладченко Виктор Леонидович',
         '/images/shatun/shatun-22.jpg', 'Сладченко Виктор Леонидович',
         '/images/shatun/shatun-23.jpg', 'Сладченко Виктор Леонидович'
       ),
       updated_at = NOW()
 WHERE slug = 'shatun'
   AND gallery_credits = '{}'::jsonb;

UPDATE partners
   SET video_clips = jsonb_build_array(
         jsonb_build_object('url', '/video/shatun/clip-water-approach.mp4',
                            'poster', '/video/shatun/clip-water-approach.poster.jpg',
                            'label', 'Вахтовка идёт через воду'),
         jsonb_build_object('url', '/video/shatun/clip-ferry-rope.mp4',
                            'poster', '/video/shatun/clip-ferry-rope.poster.jpg',
                            'label', 'Рядом с паромом'),
         jsonb_build_object('url', '/video/shatun/clip-beach-exit.mp4',
                            'poster', '/video/shatun/clip-beach-exit.poster.jpg',
                            'label', 'Выход на берег')
       ),
       updated_at = NOW()
 WHERE slug = 'shatun'
   AND video_clips = '[]'::jsonb;

-- Исход называется вслух.
DO $$
DECLARE
  v_credits int;
  v_clips   int;
BEGIN
  SELECT (SELECT count(*) FROM jsonb_object_keys(gallery_credits)), jsonb_array_length(video_clips)
    INTO v_credits, v_clips
    FROM partners WHERE slug = 'shatun';
  IF v_credits IS DISTINCT FROM 8 OR v_clips IS DISTINCT FROM 3 THEN
    RAISE WARNING '[1186] «Шатун»: подписей % (нужно 8), клипов % (нужно 3); карта могла быть заполнена раньше из админки', v_credits, v_clips;
  END IF;
END $$;

COMMIT;
