-- Migration 1269: external_alerts — одно соглашение о времени: стенное UTC
-- Created: 2026-10-15
--
-- #2495, решение владельца 15.10 («го»). Колонки created_at / expires_at /
-- updated_at — timestamp без пояса. Ингест пишет их датой JS с сервера в UTC
-- (стенное время UTC), а сравнение `expires_at > NOW()` толковало стенное время
-- поясом сессии (+03 на проде): тревоги уходили из ленты на три часа раньше,
-- закрытие дороги «до 10 утра» гасло в 7 утра. Код с этим PR сравнивает и пишет
-- стенным UTC (`UTC_WALL_NOW_SQL`, lib/db/timestamp-iso).
--
-- Лежащие строки писались ещё по-старому, и их приводит эта миграция:
--  1. created_at ручных записей (manual-…: миграции 718/729 и админка ставили
--     NOW() — стенное время пояса сессии) переводится в стенное UTC;
--  2. срок, продлённый основанием дорожного закрытия (road-basis-queue писал
--     GREATEST(expires_at, $4::timestamptz) — тоже в поясе сессии),
--     переводится в стенное UTC — узнаётся точным равенством basis_valid_until;
--  3. погашенное остаётся погашенным: строка, истёкшая по старому правилу, но
--     живая по новому, иначе вернулась бы в ленту на срок до трёх часов —
--     погашенное админкой ограничение, отозванное предупреждение Росгидромета.
--
-- Перевод времени нельзя применить дважды: второй прогон сдвинул бы ещё на три
-- часа. Однократность держит отметка в _migrations в той же транзакции, что и
-- сами правки, — повтор (например, после сбоя между COMMIT и записью раннера)
-- ничего не меняет. Пояс берётся current_setting('TimeZone') — тот же, в
-- котором NOW() писал эти строки; на базе в UTC перевод ничего не меняет.
--
-- updated_at существующих строк не переводится: колонку не читает никто
-- (перепись 15.10); новые значения — стенное UTC по умолчанию ниже.

BEGIN;

DO $$
DECLARE
  v_first  INT;
  v_manual INT;
  v_basis  INT;
  v_held   INT;
BEGIN
  INSERT INTO _migrations (name) VALUES ('1269_external_alerts_utc_wall.sql')
  ON CONFLICT (name) DO NOTHING;
  GET DIAGNOSTICS v_first = ROW_COUNT;
  IF v_first = 0 THEN
    RAISE NOTICE '[1269] уже применена — время второй раз не переводится';
    RETURN;
  END IF;

  -- 1. Ручные записи: created_at из пояса сессии в стенное UTC.
  UPDATE external_alerts
     SET created_at = (created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC'
   WHERE external_id LIKE 'manual-%'
     AND created_at IS NOT NULL;
  GET DIAGNOSTICS v_manual = ROW_COUNT;

  -- 2. Срок, продлённый основанием, — из пояса сессии в стенное UTC.
  UPDATE external_alerts
     SET expires_at = basis_valid_until AT TIME ZONE 'UTC'
   WHERE basis_valid_until IS NOT NULL
     AND expires_at = (basis_valid_until AT TIME ZONE current_setting('TimeZone'));
  GET DIAGNOSTICS v_basis = ROW_COUNT;

  -- 3. Истёкшее по старому правилу остаётся истёкшим и по новому.
  UPDATE external_alerts
     SET expires_at = (NOW() AT TIME ZONE 'UTC')
   WHERE expires_at <= LOCALTIMESTAMP
     AND expires_at > (NOW() AT TIME ZONE 'UTC');
  GET DIAGNOSTICS v_held = ROW_COUNT;

  RAISE NOTICE '[1269] ручных created_at — %, сроков по основанию — %, удержано погашенных — %',
    v_manual, v_basis, v_held;
END $$;

-- Писатель, пропустивший время, получает стенное UTC, а не пояс сессии.
ALTER TABLE external_alerts ALTER COLUMN created_at SET DEFAULT (NOW() AT TIME ZONE 'UTC');
ALTER TABLE external_alerts ALTER COLUMN updated_at SET DEFAULT (NOW() AT TIME ZONE 'UTC');

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE external_alerts ALTER COLUMN created_at SET DEFAULT NOW();
-- ALTER TABLE external_alerts ALTER COLUMN updated_at SET DEFAULT NOW();
-- COMMIT;
-- Перевод времени данных обратно не откатывается: код до этой миграции
-- читал стенное время поясом сессии, и ручные created_at вернулись бы через
-- (created_at AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone').
