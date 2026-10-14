-- 1242_route_suffix_from_hidden_twin.sql
--
-- Адрес `<имя>-marshrut`, который держит СКРЫТЫЙ маршрут-тёзка, — видимому.
-- Решение владельца 14.10 («передать видимому») на случай, который 1239 не
-- покрыл: там переходил адрес по имени, здесь — адрес с суффиксом.
--
-- ── Повод (перепись на проде 14.10, 05:25 UTC, после #2464) ────────────────
--
-- После 1239 без адреса остался один видимый маршрут — «Зеленовские озерки»
-- (cf257914, открывается по UUID). Перепись `route-slug-census` назвала обоих
-- держателей:
--   — адрес по имени `zelenovskie-ozerki` держит видимое место (f31f3774) —
--     по 1239 маршрут к месту получает `<имя>-marshrut`;
--   — но `zelenovskie-ozerki-marshrut` держит скрытый и не слитый маршрут с
--     тем же именем (191ccd49). Суффикс ему выдала 1112 (29.09): тогда он
--     держал адрес по имени, и тот перешёл месту.
--
-- 1239 переносила видимому адрес скрытого тёзки только по ИМЕНИ. Суффиксный
-- адрес — тот же случай по существу: скрытый маршрут никого не ведёт (его
-- страница отвечает 404), а видимый с тем же именем и с адресом-по-праву
-- стоит по UUID.
--
-- ── Что делает миграция ───────────────────────────────────────────────────
--
-- Разово, по ПРАВИЛУ, а не по списку: видимый и не слитый маршрут без адреса
-- получает `<имя>-marshrut`, а скрытый держатель остаётся без адреса, если
--   — адрес по имени держит место (иначе правило 1239 дало бы не суффикс);
--   — суффикс держит маршрут, скрытый и не слитый, с ТЕМ ЖЕ адресом по имени
--     (тёзка, а не чужой маршрут, случайно взявший похожий адрес);
--   — суффикс не держит место;
--   — видимый претендент на это имя один: тёзки не делят адрес «кто первый».
-- Слитый держатель и видимый держатель (дубль — «Мыс Лопатка» в стороже)
-- не трогаются: о них решения владельца нет.
--
-- В триггер перенос НЕ входит — по той же причине, что в 1239: скрытый
-- маршрут может быть скрыт на время модерации.
--
-- Идемпотентна: второй прогон не находит видимых маршрутов без адреса с
-- таким держателем.

DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT r.id AS route_id, h.id AS holder_id, h.slug AS suffixed
      FROM kamchatka_routes r
      JOIN kamchatka_routes h
        ON h.slug = translit_ru_slug(r.title) || '-marshrut'
     WHERE (r.slug IS NULL OR r.slug = '')
       AND r.is_visible = TRUE
       AND r.merged_into_id IS NULL
       AND translit_ru_slug(r.title) <> ''
       AND h.id::text <> r.id::text
       AND h.is_visible = FALSE
       AND h.merged_into_id IS NULL
       -- держатель — тёзка
       AND translit_ru_slug(h.title) = translit_ru_slug(r.title)
       -- адрес по имени держит место
       AND EXISTS (SELECT 1 FROM places p WHERE p.slug = translit_ru_slug(r.title))
       -- суффикс не держит место
       AND NOT EXISTS (SELECT 1 FROM places p WHERE p.slug = h.slug)
       -- видимый претендент один
       AND NOT EXISTS (
         SELECT 1
           FROM kamchatka_routes c
          WHERE c.id::text <> r.id::text
            AND (c.slug IS NULL OR c.slug = '')
            AND c.is_visible = TRUE
            AND c.merged_into_id IS NULL
            AND translit_ru_slug(c.title) = translit_ru_slug(r.title)
       )
     ORDER BY r.created_at, r.id
  LOOP
    UPDATE kamchatka_routes
       SET slug = NULL,
           updated_at = NOW()
     WHERE id::text = m.holder_id::text
       AND slug = m.suffixed;
    UPDATE kamchatka_routes
       SET slug = m.suffixed,
           updated_at = NOW()
     WHERE id::text = m.route_id::text
       AND (slug IS NULL OR slug = '');
  END LOOP;
END $$;
