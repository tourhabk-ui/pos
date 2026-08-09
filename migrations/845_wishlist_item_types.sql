-- 845: избранное принимает точки и маршруты наравне с турами.
--
-- Владелец 09.08: «избранное так и не работает». Карточки витрины сохраняли
-- места и маршруты, а сервер знал только tour/accommodation/partner/
-- destination/activity. Сущностей у платформы три — точка, маршрут, тур
-- (CLAUDE.md §4.1), и избранное обязано уметь все три.
--
-- Таблица `tourist_wishlist` старше каталога миграций, поэтому имя
-- ограничения заранее неизвестно: снимаем все проверки по `item_type`, какие
-- бы имена им ни дали, и ставим одну известную. Идемпотентно: повторный
-- прогон снимет и поставит то же самое.
-- `destination` остаётся в списке — так до 09.08 назывались места, и уже
-- сохранённое туристами избранное не должно стать нечитаемым.

DO $$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.tourist_wishlist') IS NULL THEN
    RAISE NOTICE 'tourist_wishlist отсутствует — пропускаем';
    RETURN;
  END IF;

  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.tourist_wishlist'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%item_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.tourist_wishlist DROP CONSTRAINT %I', c.conname);
  END LOOP;

  ALTER TABLE public.tourist_wishlist
    ADD CONSTRAINT tourist_wishlist_item_type_chk
    CHECK (item_type IN (
      'tour', 'route', 'place', 'accommodation', 'partner', 'activity', 'destination'
    ));
END $$;
