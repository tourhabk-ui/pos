-- 1022: чья это продажа — агент брони.
--
-- Решение владельца 26.09 («ссылка + бронь за клиента»): агент продаёт двумя
-- путями, и оба создают ОБЫЧНУЮ бронь оператора — по своей ссылке (турист
-- бронирует сам) или оформляя заявку за клиента. До этого дня продажа по
-- ссылке записывалась только одной дверью (/api/bookings/tour, та, что брала
-- оплату до подтверждения), а бронь за клиента шла в отдельную agent_bookings,
-- которую оператор не видел.
--
-- agent_user_id — ОДИН признак для обоих путей: кому засчитана бронь.
-- Пишет его бронирование (lib/bookings/reserve.ts: по коду ссылки — владелец
-- ссылки, по брони за клиента — сам агент); читает комиссия агента. NULL —
-- «продажа без агента», это нормальное состояние, а не пробел.
--
-- Колонка к users, а не к partners: агент опознаётся по users.id во всех
-- таблицах своего кабинета (agent_clients, agent_commissions,
-- agent_referral_links).

ALTER TABLE operator_bookings
  ADD COLUMN IF NOT EXISTS agent_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_operator_bookings_agent_user
  ON operator_bookings (agent_user_id) WHERE agent_user_id IS NOT NULL;

-- Уже атрибутированные ссылкой брони получают агента из самой ссылки.
UPDATE operator_bookings ob
   SET agent_user_id = l.agent_id
  FROM agent_referral_links l
 WHERE ob.referral_link_id = l.id
   AND ob.agent_user_id IS NULL;
