-- 1408: «Лагуна Экспедиция» — восемь туров, которые оператор перенёс у себя
-- в архив, снимаются с витрины; у «В гости к северным оленям и ездовым
-- собакам» — новая цена с сайта оператора.
--
-- ── Основание ─────────────────────────────────────────────────────────────
-- Отчёт наблюдения за сайтами партнёров 08.11 (lib/partners/site-watch,
-- «Сайты партнёров: изменений — 29») и слово в нём: «Наши карточки этих туров
-- могли устареть — сверьте и поправьте». Владелец переслал отчёт 08.11.
--
-- Сверены все 34 страницы, с которых 1339 взяла туры (source_url), снятые
-- 08.11.2026 под именем VedarSiteWatch: каждая отвечает 200, ни одна не
-- пропала. На восьми страницах вместо цены и календаря стоит «Тур находится в
-- архиве» и «Данный тур находится в архиве. Но Вы можете выбрать актуальный тур
-- из списка ниже»:
--   40400 «Дачные горячие источники на внедорожнике Tank-300»;
--   40401 «К Гамулам на Вилючинский перевал на внедорожнике Tank-300»;
--   40431 «В гости к евражкам на Авачинский перевал»;
--   41599 «Камчатка на максимум: осенний маршрут»;
--   41915 «Водопад «Снежный барс» + Вилючинский перевал на вездеходе Sever Truck»;
--   41918 «Водопад «Снежный барс» + Вилючинский перевал»;
--   43580 «Крабовое сафари в Авачинской бухте»;
--   45166 «Каньон Опасный + Дачные источники на вездеходе Sever Truck».
-- Оператор их сейчас не продаёт, а у нас на них можно было оставить заявку —
-- карточка обещала тур, которого нет (§0).
--
-- Цена: на странице 40935 «В гости к северным оленям и ездовым собакам» —
-- «от 9 000 руб.» (у нас с 26.10 — 8 500). Слово владельца 26.10 к переносу
-- «2 цены актуальные»: цена сайта — действующая. Остальные 22 цены сошлись.
--
-- ── Почему is_published, а не is_active ───────────────────────────────────
-- Тот же выбор, что у 982: is_published = FALSE — «тур цел, не показываем».
-- Архив у оператора — не «больше не водим»: многие из этих туров летние и
-- осенние. Вернёт тур на сайт — карточку включают обратно одним флагом.
-- Само наблюдение этого не заметит: на 08.11 оно читает страницы только
-- туров на витрине (`watchedPages`, lib/partners/site-watch-run.ts), и
-- страницы снятых туров из его очереди уходят.
--
-- ── Чего здесь нет, и это намеренно ───────────────────────────────────────
--   • 40399 «Дачные горячие источники на вездеходе Sever Truck» остаётся: он
--     не в архиве, у него нет дат на сайте, и вместо цены там «от Бесплатно».
--     Это заглушка их сайта, а не цена; 19 000 у нас — последняя названная.
--   • Новые туры с сайта (их номера 36212, 36214, 37577, 37584, 41467, 41610,
--     51446) не переносятся: это решение владельца, а не сверка.
--
-- Правки оператора не перетираются: снимается только опубликованный тур
-- «Лагуны» по адресу страницы, цена меняется, только если в ней прежние
-- 8 500. Повтор ничего не меняет. Исход — WARNING в конце.

BEGIN;

UPDATE operator_tours t
   SET is_published = FALSE,
       updated_at = NOW()
  FROM partners p
 WHERE p.id::text = t.operator_id::text
   AND p.slug = 'laguna-expedition'
   AND t.is_published IS TRUE
   AND t.source_url = ANY (ARRAY[
     'https://laguna-expedition.ru/tours/40400-dachnye-goryachie-istochniki-na-vnedorozhnike-tank-300',
     'https://laguna-expedition.ru/tours/40401-k-gamulam-na-vilyuchinskij-pereval-na-vnedorozhnike-tank-300',
     'https://laguna-expedition.ru/tours/40431-voskhozhdenie-na-ekstruziyu-verblyud-avachinskij-pereval',
     'https://laguna-expedition.ru/tours/41599-kamchatka-na-maksimum-osennij-marshrut',
     'https://laguna-expedition.ru/tours/41915-vodopad-snezhnyj-bars-vilyuchinskij-pereval-na-vezdekhode-sever-truck',
     'https://laguna-expedition.ru/tours/41918-vodopad-snezhnyj-bars-vilyuchinskij-pereval',
     'https://laguna-expedition.ru/tours/43580-krabovoe-safari-v-avachinskoj-bukhte',
     'https://laguna-expedition.ru/tours/45166-kanon-opasnyj-dachnye-istochniki-na-vezdekhode-sever-truck'
   ]::text[]);

UPDATE operator_tours t
   SET base_price = 9000,
       price_note = replace(
         t.price_note,
         'Цена от 8 500 ₽ за человека по сайту оператора на 26.10.2026.',
         'Цена от 9 000 ₽ за человека по сайту оператора на 08.11.2026.'
       ),
       updated_at = NOW()
  FROM partners p
 WHERE p.id::text = t.operator_id::text
   AND p.slug = 'laguna-expedition'
   AND t.source_url = 'https://laguna-expedition.ru/tours/40935-pitomnik-ezdovykh-sobak-snezhnye-psy'
   AND t.base_price = 8500;

-- Исход вслух: восемь архивных туров «Лагуны» не на витрине, а цена у тура
-- 40935 — 9 000. Иное (карточки нет, туры удалены, оператор сам сменил цену)
-- называется, а не молчит.
DO $$
DECLARE
  v_partner int;
  v_hidden int;
  v_published int;
  v_price numeric;
BEGIN
  SELECT count(*) INTO v_partner FROM partners WHERE slug = 'laguna-expedition';
  SELECT count(*) FILTER (WHERE t.is_published IS NOT TRUE),
         count(*) FILTER (WHERE t.is_published IS TRUE)
    INTO v_hidden, v_published
    FROM operator_tours t JOIN partners p ON p.id::text = t.operator_id::text
   WHERE p.slug = 'laguna-expedition'
     AND t.source_url ~ '/tours/(40400|40401|40431|41599|41915|41918|43580|45166)-';
  SELECT t.base_price INTO v_price
    FROM operator_tours t JOIN partners p ON p.id::text = t.operator_id::text
   WHERE p.slug = 'laguna-expedition'
     AND t.source_url = 'https://laguna-expedition.ru/tours/40935-pitomnik-ezdovykh-sobak-snezhnye-psy';
  IF v_partner = 0 THEN
    RAISE WARNING '[1408] карточки laguna-expedition нет — снимать и править нечего';
  ELSIF v_hidden <> 8 OR v_published <> 0 THEN
    RAISE WARNING '[1408] архивных туров «Лагуны» снято с витрины: % из 8, опубликованными осталось: %', v_hidden, v_published;
  ELSIF v_price IS DISTINCT FROM 9000 THEN
    RAISE WARNING '[1408] цена тура 40935 — % (ждали 9 000): прежней 8 500 не было, правку не трогали', v_price;
  END IF;
END $$;

COMMIT;
