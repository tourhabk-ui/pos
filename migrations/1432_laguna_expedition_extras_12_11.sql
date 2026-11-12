-- 1432: «Лагуна Экспедиция» — новые доплаты с сайта оператора (12.11)
-- Created: 2026-11-12
--
-- Наблюдение за сайтами партнёров 12.11 (владелец переслал сводку: «Наши
-- карточки этих туров могли устареть — сверьте и поправьте») нашло на сайте
-- laguna-expedition.ru новые строки доплат:
--   - «Ужин «шведский стол» в ресторане «Мишка» (с включенными алкогольными
--     напитками) - 2 000 руб.» — у туров «Вулканы Камчатки (4 дня)»,
--     «Вулканы Камчатки (5 дней)» и «Камчатка на максимум: зимний маршрут»;
--   - две замены трансфера по 3 000 руб. — у зимнего маршрута (у двух
--     «Вулканов Камчатки» они на Ведаре уже есть).
-- Строки добавляются в «Не входит» словами сайта, только если такой строки
-- ещё нет; остальное в турах не трогается.
--
-- Что сверено и править не нужно:
--   - цены на страницах этих туров сводка не меняла; строки «Стоимость тура»
--     поменялись только на главной странице сайта (подборка туров), и по ним
--     не видно, к какому туру относится цифра — по догадке цену не меняем;
--   - плашка «Трижды выгодно» снята с 31 страницы сайта; на карточках Ведара
--     её не было.
--
-- IDEMPOTENT

BEGIN;

CREATE TEMP TABLE _lag1432 (slug text, item text, ord int) ON COMMIT DROP;
INSERT INTO _lag1432 (slug, item, ord) VALUES
  ('lagexp-vulkany-kamchatki-4-dnya', 'за доплату: ужин «шведский стол» в ресторане «Мишка» (с включенными алкогольными напитками) - 2 000 руб.', 1),
  ('lagexp-vulkany-kamchatki-5-dnej', 'за доплату: ужин «шведский стол» в ресторане «Мишка» (с включенными алкогольными напитками) - 2 000 руб.', 1),
  ('lagexp-kamchatka-na-maksimum-zimnij-marshrut', 'за доплату: ужин «шведский стол» в ресторане «Мишка» (с включенными алкогольными напитками) - 2 000 руб.', 1),
  ('lagexp-kamchatka-na-maksimum-zimnij-marshrut', 'за доплату: замена трансфера с отель-аэропорт на отель-Петропавловск-Камчатский - 3 000 руб.', 2),
  ('lagexp-kamchatka-na-maksimum-zimnij-marshrut', 'за доплату: замена сборного трансфера из (в) аэропорт на индивидуальный, цена за авто - 3 000 руб.', 3);

DO $$
DECLARE
  v_tours int;
  v_added int := 0;
  r record;
BEGIN
  SELECT COUNT(DISTINCT t.id) INTO v_tours
    FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
    JOIN _lag1432 l ON l.slug = t.slug
   WHERE t.deleted_at IS NULL;
  IF v_tours <> 3 THEN
    RAISE WARNING '[1432] туров «Лагуны Экспедиции» найдено %, ожидалось 3', v_tours;
  END IF;

  FOR r IN SELECT slug, item FROM _lag1432 ORDER BY slug, ord LOOP
    UPDATE operator_tours t
       SET not_included = array_append(COALESCE(t.not_included, ARRAY[]::text[]), r.item),
           updated_at = NOW()
      FROM partners p
     WHERE p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
       AND t.slug = r.slug AND t.deleted_at IS NULL
       AND NOT (r.item = ANY (COALESCE(t.not_included, ARRAY[]::text[])));
    IF FOUND THEN v_added := v_added + 1; END IF;
  END LOOP;

  RAISE NOTICE '[1432] туров: %, добавлено строк доплат: %', v_tours, v_added;
END $$;

COMMIT;
