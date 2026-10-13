-- Migration 1223: менеджеры в команде оператора (CRM фаза 2г)
-- Created: 2026-10-11
--
-- Решение владельца 11.10 («2г да»): у оператора бывают менеджеры, и им
-- доступно в кабинете всё, кроме денег и настроек. Ответы владельца на четыре
-- вопроса плана (#2313):
--   1. менеджер попадает в команду «по ссылке от партнёра любым способом» —
--      владелец создаёт приглашение и пересылает ссылку как угодно (мессенджер,
--      почта, лично); человек входит своим аккаунтом и принимает;
--   2. править цены — право, которое даёт владелец (can_edit_prices);
--   3. отменять брони — «решение за партнёром» (can_cancel_bookings);
--   4. уведомления менеджерам — да (отдельным шагом поверх этой таблицы).
--
-- Роли manager в JWT нет и не будет: lib/auth.ts и middleware.ts не трогаются
-- (§7). Менеджер входит с ролью operator, а владелец он кабинета или менеджер,
-- решает эта таблица — резолвер lib/operators/team-access.ts.
--
-- operator_staff из baseline не используется: у неё свой пароль и почта, то
-- есть второй вход мимо users, и код её не читал ни разу.
--
-- Ссылка одноразовая: в базе только sha256 токена, сам токен показывается
-- владельцу один раз. После принятия хеш стирается.

BEGIN;

CREATE TABLE IF NOT EXISTS operator_members (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id          UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- NULL, пока приглашение не принято: ссылку может принять любой аккаунт.
  user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'revoked')),
  -- Подпись владельца для себя: «Анна, менеджер продаж». Не ПД туриста.
  label               TEXT CHECK (label IS NULL OR char_length(label) <= 100),
  invite_token_hash   TEXT UNIQUE,
  invite_expires_at   TIMESTAMPTZ,
  invited_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  can_edit_prices     BOOLEAN NOT NULL DEFAULT FALSE,
  can_cancel_bookings BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Ждущее приглашение — это ссылка со сроком.
  CONSTRAINT operator_members_invited_has_link CHECK (
    status <> 'invited' OR (invite_token_hash IS NOT NULL AND invite_expires_at IS NOT NULL)
  ),
  -- Действующий менеджер — это человек, принявший приглашение.
  CONSTRAINT operator_members_active_has_user CHECK (
    status <> 'active' OR (user_id IS NOT NULL AND accepted_at IS NOT NULL)
  ),
  CONSTRAINT operator_members_revoked_complete CHECK (
    status <> 'revoked' OR revoked_at IS NOT NULL
  )
);

-- Один человек — менеджер не больше чем одного оператора разом: иначе «какой
-- кабинет открыть» пришлось бы угадывать.
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_members_active_user
  ON operator_members(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_operator_members_partner
  ON operator_members(partner_id, status);

COMMENT ON TABLE operator_members IS 'Менеджеры в команде оператора (CRM 2г). Владелец — partners.user_id; менеджер — строка здесь со status=active. Резолвер: lib/operators/team-access.ts.';
COMMENT ON COLUMN operator_members.invite_token_hash IS 'sha256 токена ссылки-приглашения. Сам токен не хранится; после принятия хеш стирается.';
COMMENT ON COLUMN operator_members.can_edit_prices IS 'Владелец разрешил менеджеру править цены туров и скидки.';
COMMENT ON COLUMN operator_members.can_cancel_bookings IS 'Владелец разрешил менеджеру отменять брони.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS operator_members;
-- COMMIT;
