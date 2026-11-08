-- 1412: «Лагуна Экспедиция» — «Дачные горячие источники на вездеходе Sever
-- Truck» снимается с витрины.
--
-- ── Основание ─────────────────────────────────────────────────────────────
-- Сверка по отчёту наблюдения 08.11 (та же, что у 1408). Страница тура на
-- сайте оператора (40399) не в архиве, но дат на ней нет, а вместо цены
-- стоит «от Бесплатно» — заглушка их сайта. У нас оставалась последняя
-- названная цена, 19 000, и на тур можно было оставить заявку. Вопрос
-- владельцу 08.11 «оставить или снять?» — ответ «снять».
--
-- Тот же выбор, что у 1408 и 982: is_published = FALSE — тур цел, не
-- показываем. Назовёт оператор цену и даты — карточку включают обратно одним
-- флагом. Наблюдение за сайтами этого не заметит: оно читает страницы только
-- туров на витрине (`watchedPages`).
--
-- Снимается только опубликованный тур «Лагуны» по адресу страницы. Повтор
-- ничего не меняет. Исход — WARNING в конце.

BEGIN;

UPDATE operator_tours t
   SET is_published = FALSE,
       updated_at = NOW()
  FROM partners p
 WHERE p.id::text = t.operator_id::text
   AND p.slug = 'laguna-expedition'
   AND t.is_published IS TRUE
   AND t.source_url = 'https://laguna-expedition.ru/tours/40399-dachnye-goryachie-istochniki-na-vezdekhode-sever-truck';

-- Исход вслух: тур не на витрине. Иное (карточки нет, тура нет) называется.
DO $$
DECLARE
  v_found int;
  v_published int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE t.is_published IS TRUE)
    INTO v_found, v_published
    FROM operator_tours t JOIN partners p ON p.id::text = t.operator_id::text
   WHERE p.slug = 'laguna-expedition'
     AND t.source_url = 'https://laguna-expedition.ru/tours/40399-dachnye-goryachie-istochniki-na-vezdekhode-sever-truck';
  IF v_found = 0 THEN
    RAISE WARNING '[1412] тура 40399 «Лагуны Экспедиции» нет — снимать нечего';
  ELSIF v_published > 0 THEN
    RAISE WARNING '[1412] тур 40399 «Лагуны Экспедиции» остался на витрине: %', v_published;
  END IF;
END $$;

COMMIT;
