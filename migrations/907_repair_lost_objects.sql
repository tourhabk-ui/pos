-- Migration 907: восстановить объекты, которые числятся созданными, но
-- которых на боевой базе нет. Партия 1 — то, что использует код.
--
-- ФАКТ (перепись /api/cron/schema-drift на проде, 22.08.2026 13:13 UTC):
-- 412 файлов миграций, все записаны применёнными, 43 их действия на базе
-- отсутствуют — 18 таблиц и 25 колонок. Механизм тот же, что у миграции 906:
-- файл идёт одной транзакцией, падение любого оператора откатывает его
-- целиком, а запись в `_migrations` делалась всё равно (задача #58).
--
-- ЗДЕСЬ НЕ ПОВТОРЯЕТСЯ СТАРЫЙ DDL. Две из восстанавливаемых миграций падали
-- не по невезению, а потому что были написаны неверно, и повтор дал бы тот
-- же результат:
--
--   121: `guide_operator_id BIGINT REFERENCES partners(id)` — а `partners.id`
--        имеет тип uuid. Внешний ключ на колонку другого типа не создаётся,
--        и файл откатывался при каждом деплое.
--   084: `booking_id UUID` под `operator_bookings.id`, который bigint. Даже
--        если бы таблица создалась, ни одна вставка комиссии не прошла бы.
--
-- Поэтому типы взяты из фактической схемы прода, а не из старых файлов.
--
-- Причину падения 126 (security_blocks, zone_capacity_limits, users) я не
-- знаю: текста ошибки того прогона не сохранилось, а в самом файле ничего
-- заведомо неверного не видно. Так и записано — вместо догадки.
--
-- ЧТО ЭТО СТОИЛО. `operator_commissions` — комиссия платформы с каждой
-- оплаты. Таблицы нет, а `recordCommissionFromBooking()` пишет в неё внутри
-- пустого `catch` (сознательного: платёж важнее записи). Значит комиссия не
-- начислялась НИ РАЗУ, и узнать об этом было неоткуда — ровно то «место, где
-- нельзя сказать „не знаю“», о котором §4.0. Молчание catch здесь оставлено,
-- но теперь оно пишет причину в лог.
--
-- Ставка по умолчанию — 0.10, а не 0.12 из файла 084: решение владельца
-- 04.08 («пока нет партнёров делаем 10%»), миграция 811 привела к нему и
-- дефолты колонок, и значения у партнёров. Источник истины всё равно
-- `partners.commission_current` — дефолт нужен лишь чтобы столбец не молчал.
--
-- Партия 2 (модуль поддержки: tickets, ticket_messages, sla_*, surveys,
-- support_agents, feedback, knowledge_base_articles) СЮДА НЕ ВХОДИТ. Эти
-- таблицы не восстанавливаются и не объявляются лишними: сначала нужно
-- решение владельца, существует ли модуль поддержки вообще. Догадка о том,
-- что таблица «наверное, не нужна», — это выключение сигнализации.

BEGIN;

-- ── Комиссия платформы ────────────────────────────────────────
-- booking_id — bigint под operator_bookings.id (в 084 стоял uuid).
CREATE TABLE IF NOT EXISTS operator_commissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  booking_id    BIGINT REFERENCES operator_bookings(id) ON DELETE SET NULL,
  invoice_id    TEXT NOT NULL UNIQUE,
  amount        NUMERIC(12,2) NOT NULL,
  rate          NUMERIC(5,4) NOT NULL DEFAULT 0.10,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'cancelled')),
  paid_at       TIMESTAMP,
  notes         TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_op_commissions_operator ON operator_commissions(operator_id);
CREATE INDEX IF NOT EXISTS idx_op_commissions_booking  ON operator_commissions(booking_id);
CREATE INDEX IF NOT EXISTS idx_op_commissions_status   ON operator_commissions(status);
CREATE INDEX IF NOT EXISTS idx_op_commissions_created  ON operator_commissions(created_at DESC);

-- ── Блокировка пользователя (126) ─────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

-- ── Связь гида с оператором (121) ─────────────────────────────
-- Тип исправлен на uuid: partners.id — uuid, а не bigint.
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS guide_operator_id UUID REFERENCES partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_partners_guide_operator
  ON partners(guide_operator_id)
  WHERE guide_operator_id IS NOT NULL;

-- ── Блокировки безопасности (126) ─────────────────────────────
CREATE TABLE IF NOT EXISTS security_blocks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip         TEXT UNIQUE,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  blocked_by TEXT NOT NULL DEFAULT 'manual',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT security_blocks_target CHECK (ip IS NOT NULL OR user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_security_blocks_ip ON security_blocks(ip) WHERE ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_security_blocks_expires ON security_blocks(expires_at) WHERE expires_at IS NOT NULL;

-- ── Потолок посещаемости зоны (126) ───────────────────────────
CREATE TABLE IF NOT EXISTS zone_capacity_limits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone               TEXT UNIQUE NOT NULL,
  max_daily_visitors INT NOT NULL CHECK (max_daily_visitors > 0),
  reason             TEXT,
  set_by             TEXT NOT NULL DEFAULT 'manual',
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zone_capacity_zone ON zone_capacity_limits(zone);

COMMIT;
