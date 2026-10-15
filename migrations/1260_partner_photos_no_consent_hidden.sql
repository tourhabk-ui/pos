-- 1260: Снимки «Местечка Камчатка» сняты с карточек мест до согласия партнёра
-- Created: 2026-10-15
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- «Местечко Камчатка» дало «ДА» на размещение своих туров (1217), и 14.10
-- кадры с этих туров легли и на карточки мест — Налычево (1248), национальный
-- парк «Вулканы Камчатки» (1250), Курильское озеро (1252), парк и вулкан
-- Вилючинский (1254), остров Старичков (1256). На вопрос, покрывает ли то
-- «ДА» карточки мест, владелец 15.10 ответил: «пока нет получим согласе
-- востановим».
--
-- ── Как спрятано ──────────────────────────────────────────────────────────
--
-- Не удаляется ничего: ни строки, ни объекты в хранилище, — вернуть их нужно
-- будет одной правкой, когда согласие появится.
--   главный кадр (ai_route_images) — род `partner-no-consent`
--     (lib/images/origin.ts): карточка его не показывает, раздача по прямому
--     адресу не отдаёт, сборщик Commons не перезаписывает;
--   галерея (place_gallery_photos) — новая колонка `hidden_reason`: у
--     галереи рода нет, а показывалось всё, что лежит у места. Карточка,
--     фото путевых точек маршрута и раздача кадра читают только строки без
--     причины.
-- Отбор — по автору «Местечко Камчатка»: так подписан каждый их кадр в
-- 1248–1256, и туры с карточкой оператора в этих таблицах не лежат
-- (operator_tours, partners).
--
-- Главные кадры статей летописи «Налычево» и «Вилючинский» заменены снимками
-- владельца, у «Вулканов Камчатки» главного кадра нет — это код
-- (lib/chronicle/articles.ts), не эта миграция.
--
-- IDEMPOTENT

BEGIN;

ALTER TABLE place_gallery_photos ADD COLUMN IF NOT EXISTS hidden_reason TEXT;

UPDATE place_gallery_photos
   SET hidden_reason = 'снимок партнёра «Местечко Камчатка»: согласия на показ на карточках мест пока нет (владелец 15.10) — вернётся вместе с согласием'
 WHERE author = 'Местечко Камчатка'
   AND hidden_reason IS NULL;

UPDATE ai_route_images
   SET model = 'partner-no-consent'
 WHERE author = 'Местечко Камчатка'
   AND model = 'manual-upload';

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_gallery_hidden int;
  v_gallery_shown int;
  v_hero_hidden int;
  v_hero_shown int;
BEGIN
  SELECT count(*) FILTER (WHERE hidden_reason IS NOT NULL),
         count(*) FILTER (WHERE hidden_reason IS NULL)
    INTO v_gallery_hidden, v_gallery_shown
    FROM place_gallery_photos WHERE author = 'Местечко Камчатка';
  SELECT count(*) FILTER (WHERE model = 'partner-no-consent'),
         count(*) FILTER (WHERE model IN ('wikimedia', 'manual-upload'))
    INTO v_hero_hidden, v_hero_shown
    FROM ai_route_images WHERE author = 'Местечко Камчатка';

  IF v_gallery_shown > 0 OR v_hero_shown > 0 THEN
    RAISE WARNING '[1260] кадры «Местечко Камчатка» ещё показываются: галерея %, главные %', v_gallery_shown, v_hero_shown;
  END IF;
  IF v_gallery_hidden + v_hero_hidden = 0 THEN
    RAISE WARNING '[1260] не спрятано ни одного кадра «Местечко Камчатка» — их нет в базе или подпись другая?';
  END IF;
END $$;

COMMIT;

-- Вернуть, когда партнёр согласится на показ на карточках мест:
-- BEGIN;
-- UPDATE place_gallery_photos SET hidden_reason = NULL
--  WHERE author = 'Местечко Камчатка' AND hidden_reason LIKE 'снимок партнёра «Местечко Камчатка»%';
-- UPDATE ai_route_images SET model = 'manual-upload'
--  WHERE author = 'Местечко Камчатка' AND model = 'partner-no-consent';
-- COMMIT;
