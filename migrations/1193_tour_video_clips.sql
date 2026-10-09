-- 1193: короткие клипы у тура (решение владельца 09.10: «нарежь короткие
-- видео для туров камчатской рыбалки, без звука, и сохрани их в S3»).
--
-- video_clips — список [{key, poster, label}]: КЛЮЧИ объектов в хранилище под
-- videos/, а не адреса. Имя бакета живёт в переменных приложения, и адрес
-- собирает сервер (lib/tours/tour-clips.ts) — в базе не остаётся строки,
-- которая перестанет работать при смене бакета или хоста. Клипы залиты
-- workflow media-to-s3.yml (маркер .github/triggers/media-to-s3.json) и
-- прочитаны обратно по публичному адресу до этой миграции.
--
-- Пустой список — «клипов нет», и блока на карточке нет.

ALTER TABLE operator_tours
  ADD COLUMN IF NOT EXISTS video_clips JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operator_tours_video_clips_shape') THEN
    ALTER TABLE operator_tours
      ADD CONSTRAINT operator_tours_video_clips_shape
      CHECK (jsonb_typeof(video_clips) = 'array');
  END IF;
END $$;

-- Клипы сняты с лодки на реке, без снега: летние и осенние туры «Камчатской
-- рыбалки». Зимним (подлёдным) турам их не ставим — показать зимнему туру
-- открытую воду значило бы пообещать не ту поездку; у них свои клипы ниже.
-- Вид рыбы в подписях не назван: по кадру его не установить, а выдумывать
-- нельзя (§4.0).
-- Только туда, где список пуст: чужую правку не затираем.
UPDATE operator_tours ot
   SET video_clips = jsonb_build_array(
         jsonb_build_object('key', 'videos/fishingkam/clip-fish-strike.mp4',
                            'poster', 'videos/fishingkam/clip-fish-strike.poster.jpg',
                            'label', 'Рыба на крючке у борта лодки'),
         jsonb_build_object('key', 'videos/fishingkam/clip-fish-landing.mp4',
                            'poster', 'videos/fishingkam/clip-fish-landing.poster.jpg',
                            'label', 'Вываживание у лодки'),
         jsonb_build_object('key', 'videos/fishingkam/clip-fish-catch.mp4',
                            'poster', 'videos/fishingkam/clip-fish-catch.poster.jpg',
                            'label', 'Улов в руках'),
         jsonb_build_object('key', 'videos/fishingkam/clip-fish-trophy.mp4',
                            'poster', 'videos/fishingkam/clip-fish-trophy.poster.jpg',
                            'label', 'Рыбак с уловом')
       ),
       updated_at = NOW()
 WHERE ot.operator_id::text = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND ot.title !~* 'зимн|подлёдн|подледн'
   AND ot.video_clips = '[]'::jsonb;

-- Зимним (подлёдным) турам — свои клипы со льда (слово владельца 09.10
-- «зима для клипа», третий ролик): улов на льду и лагерь у лунок.
UPDATE operator_tours ot
   SET video_clips = jsonb_build_array(
         jsonb_build_object('key', 'videos/fishingkam/clip-ice-catch.mp4',
                            'poster', 'videos/fishingkam/clip-ice-catch.poster.jpg',
                            'label', 'Улов на льду'),
         jsonb_build_object('key', 'videos/fishingkam/clip-ice-camp.mp4',
                            'poster', 'videos/fishingkam/clip-ice-camp.poster.jpg',
                            'label', 'На льду: улов и лагерь у лунок')
       ),
       updated_at = NOW()
 WHERE ot.operator_id::text = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND ot.title ~* 'зимн|подлёдн|подледн'
   AND ot.video_clips = '[]'::jsonb;
