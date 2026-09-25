-- 1020: команда оператора — приглашение гида и назначение гида на бронь.
--
-- ── Что было ──────────────────────────────────────────────────────────────
-- Связь «гид работает у оператора» в схеме есть с 121-й миграции —
-- partners.guide_operator_id, — и её читают пять мест: экран «Гиды»
-- оператора (GUIDES_SQL), PATCH доступности гида, «Мои туры» гида, агентство
-- гида в чате и перепись guide-readiness. Писателя у неё не было НИ ОДНОГО:
-- ни экрана, ни API, ни импорта. Все пять читателей гарантированно получали
-- пустоту, и кабинет гида работал на «пока пусто», которое было не фактом о
-- гидах, а фактом о нас.
--
-- Бронь при этом не знала, какой гид её ведёт: колонки не было, и «группы»
-- гида строились из guide_groups, в участников которой тоже не писал никто.
--
-- ── Что заводится ─────────────────────────────────────────────────────────
-- 1. guide_operator_invites — приглашение оператора гиду по e-mail аккаунта
--    гида. Статусы и их производители (все в одном изменении, §10.09):
--      pending  — POST /api/operator/guides/invites (оператор пригласил);
--      accepted — POST /api/guide/team action=accept (гид принял);
--      declined — POST /api/guide/team action=decline (гид отказался);
--      revoked  — DELETE /api/operator/guides/invites (оператор отозвал
--                 приглашение) и DELETE /api/operator/guides (оператор
--                 исключил гида из команды);
--      left     — DELETE /api/guide/team (гид вышел из команды сам).
--    Членство в команде — по-прежнему partners.guide_operator_id: его пишет
--    ТОЛЬКО принятие приглашения и стирают исключение/выход, в той же
--    транзакции, что и статус приглашения. Приглашение — история и путь,
--    а не второй источник правды о членстве.
--
-- 2. operator_bookings.guide_partner_id — какой гид ведёт бронь. Пишет
--    PUT /api/hub/operator/bookings/[id]/guide: бронь должна принадлежать
--    оператору, гид — состоять в его команде. NULL — гид не назначен (это
--    честное «не назначен», а не «нет гида»). Исключение гида из команды и
--    выход гида снимают его с будущих броней этого оператора.
--
-- ── Почему один оператор на гида, а не таблица-связка ─────────────────────
-- Гид в жизни может работать на нескольких операторов. Но у
-- guide_operator_id уже пять читателей и FK, и переписывать их всех под
-- множественную связь ради случая, которого в данных ещё нет, — работа на
-- будущее без потребителя. Принятие второго приглашения при действующем
-- членстве отвечает гиду 409 с просьбой сначала выйти из команды: это
-- ограничение сказано вслух, а не спрятано.

CREATE TABLE IF NOT EXISTS guide_operator_invites (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id      UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  guide_partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'left')),
  invited_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at     TIMESTAMPTZ
);

-- Одно ожидающее приглашение на пару: повторное «пригласить» не плодит строки.
CREATE UNIQUE INDEX IF NOT EXISTS uq_guide_operator_invites_pending
  ON guide_operator_invites (operator_id, guide_partner_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_guide_operator_invites_guide
  ON guide_operator_invites (guide_partner_id, status);

CREATE INDEX IF NOT EXISTS idx_guide_operator_invites_operator
  ON guide_operator_invites (operator_id, created_at DESC);

COMMENT ON TABLE guide_operator_invites IS
  'Приглашения гидов в команду оператора. Членство — partners.guide_operator_id, его пишет только принятие приглашения (1020).';

ALTER TABLE operator_bookings
  ADD COLUMN IF NOT EXISTS guide_partner_id UUID REFERENCES partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_operator_bookings_guide_partner
  ON operator_bookings (guide_partner_id, booking_date)
  WHERE guide_partner_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN operator_bookings.guide_partner_id IS
  'Гид, назначенный оператором на бронь (partners.id, category=guide, член команды оператора). NULL — гид не назначен.';
