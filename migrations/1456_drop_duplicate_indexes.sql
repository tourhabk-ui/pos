-- Migration 1456: сняты 28 точных дублей индексов (#3388 п.4)
-- Created: 2026-11-16
--
-- ── Основание ─────────────────────────────────────────────────────────────
--
-- Аудит схемы #3388, п.4; порядок пунктов — слово владельца 15.11 «3388»,
-- карт-бланш 16.11. Список — не из модели схемы, а с самого прода: перепись
-- GET /api/cron/duplicate-indexes-census (lib/db/duplicate-indexes.ts),
-- проверка прода, прогон 192, 16.11.2026 11:11 UTC: групп 28, к снятию 28,
-- заблокированных 0. Модель схемы (baseline + миграции) дала тот же список.
--
-- Дубль — индекс, совпадающий со своим близнецом во всём: таблица, колонки,
-- классы операторов, правила сравнения, порядок сортировки, выражение,
-- условие и метод. Два таких индекса ускоряют одно и то же, а платятся
-- дважды: каждая вставка и правка пишет оба, и оба занимают место.
--
-- Какой из пары остаётся: индекс под ограничением (в том числе тот, на
-- который опирается внешний ключ) не снимается никогда; затем уникальный;
-- затем более подробное имя. Поэтому, например, у users остаются
-- users_email_key и users_telegram_id_key — они держат ограничения
-- UNIQUE, а снимаются idx_users_email и uq_users_telegram_id (тот же
-- уникальный индекс второй раз, без ограничения).
--
-- ── Почему без проверки «близнец на месте» ────────────────────────────────
--
-- DROP INDEX CONCURRENTLY не выполняется ни в транзакции, ни в функции, и
-- обернуть его в DO-блок с проверкой нельзя. Поэтому список взят с прода, а
-- на модели схемы его держит сторож: сцена в
-- tests/integration/schema-model.pg.test.ts строит схему прода из baseline и
-- всех миграций и требует, чтобы точных дублей на ней не осталось — новый
-- дубль в миграции краснеет в своём PR.
--
-- CONCURRENTLY — чтобы снятие не запирало таблицу на запись. Раннер миграций
-- узнаёт такой файл и выполняет выражения по одному вне транзакции
-- (scripts/migrate-standalone.js, isNonTransactional). IF EXISTS — повтор
-- безопасен.
--
-- Ни код, ни тесты эти имена не называют (проверено поиском по репозиторию).

-- agent_market_payments: остаётся agent_market_payments_payment_id_key
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_market_payment_id;

-- chat_sessions: остаётся chat_sessions_user_id_idx
DROP INDEX CONCURRENTLY IF EXISTS idx_chat_sessions_user;

-- collections: остаётся collections_slug_key
DROP INDEX CONCURRENTLY IF EXISTS idx_collections_slug;

-- gear_availability: остаётся gear_availability_gear_item_id_date_key
DROP INDEX CONCURRENTLY IF EXISTS idx_gear_availability_item_date;

-- kamchatka_routes: остаётся kamchatka_routes_slug_unique
DROP INDEX CONCURRENTLY IF EXISTS idx_kamchatka_routes_slug;

-- loyalty_transactions: остаётся idx_loyalty_transactions_expires_at
DROP INDEX CONCURRENTLY IF EXISTS idx_lt_expires;

-- loyalty_transactions: остаётся idx_loyalty_transactions_type
DROP INDEX CONCURRENTLY IF EXISTS idx_lt_type;

-- loyalty_transactions: остаётся idx_loyalty_transactions_user_id
DROP INDEX CONCURRENTLY IF EXISTS idx_lt_user;

-- operator_bookings: остаётся idx_operator_bookings_booking_status
DROP INDEX CONCURRENTLY IF EXISTS idx_operator_bookings_status;

-- operator_staff: остаётся operator_staff_email_key
DROP INDEX CONCURRENTLY IF EXISTS idx_operator_staff_email;

-- operator_staff: остаётся operator_staff_max_chat_id_key
DROP INDEX CONCURRENTLY IF EXISTS idx_operator_staff_max;

-- operator_staff: остаётся operator_staff_telegram_chat_id_key
DROP INDEX CONCURRENTLY IF EXISTS idx_operator_staff_tg;

-- operator_tours: остаётся idx_operator_tours_agent_route
DROP INDEX CONCURRENTLY IF EXISTS idx_op_tours_agent_route;

-- promo_codes: остаётся promo_codes_code_key
DROP INDEX CONCURRENTLY IF EXISTS idx_promo_codes_code;

-- referrals: остаётся idx_referrals_referrer_id
DROP INDEX CONCURRENTLY IF EXISTS idx_referrals_referrer;

-- sales_outreach_log: остаётся sales_outreach_log_operator_telegram_key
DROP INDEX CONCURRENTLY IF EXISTS idx_outreach_telegram;

-- tour_departures: остаётся idx_tour_departures_start_date
DROP INDEX CONCURRENTLY IF EXISTS idx_departures_start_date;

-- tour_departures: остаётся idx_tour_departures_status
DROP INDEX CONCURRENTLY IF EXISTS idx_departures_status;

-- tour_departures: остаётся idx_tour_departures_tour_id
DROP INDEX CONCURRENTLY IF EXISTS idx_departures_tour_id;

-- tour_selections: остаётся tour_selections_code_key
DROP INDEX CONCURRENTLY IF EXISTS idx_tour_selections_code;

-- tours: остаётся idx_tours_is_active
DROP INDEX CONCURRENTLY IF EXISTS idx_tours_active;

-- transfers: остаётся transfers_booking_reference_key
DROP INDEX CONCURRENTLY IF EXISTS idx_transfers_booking_reference;

-- user_ai_memory: остаётся user_ai_memory_user_id_key
DROP INDEX CONCURRENTLY IF EXISTS idx_user_ai_memory_user_id;

-- user_sessions: остаётся user_sessions_token_key
DROP INDEX CONCURRENTLY IF EXISTS idx_user_sessions_token;

-- users: остаётся users_email_key
DROP INDEX CONCURRENTLY IF EXISTS idx_users_email;

-- users: остаётся users_telegram_id_key
DROP INDEX CONCURRENTLY IF EXISTS uq_users_telegram_id;

-- vehicles: остаётся vehicles_license_plate_key
DROP INDEX CONCURRENTLY IF EXISTS idx_vehicles_license_plate;

-- zone_capacity_limits: остаётся zone_capacity_limits_zone_key
DROP INDEX CONCURRENTLY IF EXISTS idx_zone_capacity_zone;

-- Rollback (вернуть индекс тем же определением, что на проде 16.11):
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_market_payment_id ON public.agent_market_payments USING btree (payment_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_sessions_user ON public.chat_sessions USING btree (user_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_collections_slug ON public.collections USING btree (slug);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gear_availability_item_date ON public.gear_availability USING btree (gear_item_id, date);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kamchatka_routes_slug ON public.kamchatka_routes USING btree (slug);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lt_expires ON public.loyalty_transactions USING btree (expires_at);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lt_type ON public.loyalty_transactions USING btree (type);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lt_user ON public.loyalty_transactions USING btree (user_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_bookings_status ON public.operator_bookings USING btree (booking_status);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_staff_email ON public.operator_staff USING btree (email);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_staff_max ON public.operator_staff USING btree (max_chat_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_staff_tg ON public.operator_staff USING btree (telegram_chat_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_op_tours_agent_route ON public.operator_tours USING btree (agent_route_id) WHERE (agent_route_id IS NOT NULL);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_promo_codes_code ON public.promo_codes USING btree (code);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_referrals_referrer ON public.referrals USING btree (referrer_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_telegram ON public.sales_outreach_log USING btree (operator_telegram);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_departures_start_date ON public.tour_departures USING btree (start_date);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_departures_status ON public.tour_departures USING btree (status);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_departures_tour_id ON public.tour_departures USING btree (tour_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tour_selections_code ON public.tour_selections USING btree (code);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tours_active ON public.tours USING btree (is_active);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transfers_booking_reference ON public.transfers USING btree (booking_reference);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_ai_memory_user_id ON public.user_ai_memory USING btree (user_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_sessions_token ON public.user_sessions USING btree (token);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON public.users USING btree (email);
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_users_telegram_id ON public.users USING btree (telegram_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vehicles_license_plate ON public.vehicles USING btree (license_plate);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zone_capacity_zone ON public.zone_capacity_limits USING btree (zone);
