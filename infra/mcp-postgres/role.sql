-- Роль для чтения БД из MCP: разрешительный список, не запретительный.
--
-- ЗАПУСКАЕТСЯ ВРУЧНУЮ ОДИН РАЗ, владельцем, со своим паролем. В migrations/
-- этому файлу места нет: миграции накатываются автоматически при каждом
-- деплое, а пароль в репозитории — секрет в коде (CLAUDE.md §4).
--
-- Почему список РАЗРЕШЁННЫХ, а не запрещённых. В базе 245 таблиц, и
-- персональные данные туриста растекаются по ним через JOIN: в реестре типов
-- строк пятнадцать интерфейсов несут email, телефон или хэш пароля, а
-- источник у большинства один — users. Запретительный список защищает ровно
-- до появления следующей таблицы, о которой забыли; разрешительный —
-- наоборот: незнакомая таблица закрыта по построению. Это то же правило, по
-- которому 04.09 переписан сканер D2 (там перечень знакомых брендов оказался
-- не фильтром, а слепотой).
--
-- Второе и главное: гарантия стоит НА СТОРОНЕ БАЗЫ. Официальный
-- MCP-сервер обещает читать в READ ONLY транзакции, но он помечен
-- «no longer supported», и полагаться на обещание клиента, когда речь о
-- чужих персональных данных, нельзя. Роль без права записи держит границу
-- независимо от того, что попросит клиент.
--
-- Проверить, что получилось:
--   SET ROLE mcp_readonly; SELECT count(*) FROM users;   -- должно упасть
--   SET ROLE mcp_readonly; SELECT count(*) FROM places;  -- должно ответить
--   SET ROLE mcp_readonly; DELETE FROM places;           -- должно упасть

\set ON_ERROR_STOP on

-- 1. Роль. Пароль подставьте свой — плейсхолдер оставлять нельзя.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly') THEN
    EXECUTE 'CREATE ROLE mcp_readonly LOGIN PASSWORD ' || quote_literal(:'mcp_password');
  ELSE
    EXECUTE 'ALTER ROLE mcp_readonly LOGIN PASSWORD ' || quote_literal(:'mcp_password');
  END IF;
END $$;

-- 2. Ни одной таблицы по умолчанию: роль начинает с пустых рук.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_readonly;
REVOKE CREATE ON SCHEMA public FROM mcp_readonly;
GRANT CONNECT ON DATABASE CURRENT_CATALOG TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;

-- 3. Разрешённые таблицы — предметная область замеров, без персональных
--    данных. Отсутствующая в базе таблица не роняет прогон, а называется
--    вслух: молчание здесь означало бы «доступ выдан», а это неправда.
DO $$
DECLARE
  allowed text[] := ARRAY[
    -- география и маршруты
    'places', 'kamchatka_routes', 'route_waypoints',
    'location_safety_profile', 'location_real_time_status', 'ai_route_images',
    -- коммерция БЕЗ покупателя: карточка тура и её доступность
    'operator_tours', 'tour_availability',
    -- агенты и эволюция
    'evo_growth_issues', 'agent_memory', 'funnel_events',
    -- состояние схемы (проверка деплоя)
    '_migrations'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY allowed LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('GRANT SELECT ON public.%I TO mcp_readonly', t);
    ELSE
      RAISE NOTICE 'таблицы % нет в базе — доступ не выдан', t;
    END IF;
  END LOOP;
END $$;

-- 4. Новые таблицы НЕ открываются сами. Умолчания намеренно не трогаем:
--    ALTER DEFAULT PRIVILEGES ... GRANT SELECT здесь открыл бы роли всё, что
--    заведут завтра, включая следующую таблицу с телефонами туристов.
--    Понадобится новая таблица — впишите её в список выше и прогоните заново.

-- 5. Что НЕ выдано и почему (список не для порядка, а чтобы следующий
--    читатель не «дописал по аналогии»):
--      users              — почта и хэш пароля;
--      partners           — контакты живых людей в поле contacts;
--      operator_bookings  — покупатель: имя, телефон, почта;
--      leads              — то же самое, ради чего лид и заводится;
--      tour_payments, payouts, tourist_documents — деньги и документы.
--    Всё это уходило бы в переписку с зарубежной моделью, то есть стало бы
--    трансграничной передачей ПД (152-ФЗ, CLAUDE.md §8, гарды D1/D2).
