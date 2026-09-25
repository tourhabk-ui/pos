-- 1025: ставка вознаграждения агента — одна на агента, назначает владелец.
--
-- ── Решение владельца 26.09 ────────────────────────────────────────────────
-- Ставку агента назначает владелец в админке. Нет ставки — нет комиссии:
-- агент видит «ставка не назначена», а не умолчание в процентах. Автомат эту
-- колонку не пишет никогда (§7, разбор денежного пути 11.09).
--
-- ── Почему на агента, а не на ссылку ───────────────────────────────────────
-- До этого дня ставка жила на реферальной ССЫЛКЕ (agent_referral_links,
-- миграция 1005). С 26.09 агент продаёт двумя путями — по ссылке и бронью за
-- клиента (миграция 1022, operator_bookings.agent_user_id), — и у брони за
-- клиента ссылки нет вовсе. Ставка на ссылке оставила бы такие продажи без
-- ставки навсегда. Поэтому одна ставка — на партнёрской записи агента
-- (partners, category = 'agent'), и её читает единственная функция денег
-- агента (lib/payments/agent-commission.ts).
--
-- Колонка ссылки не удаляется (миграции только вперёд), но деньги её больше
-- НЕ читают. Уже назначенные ставки ссылок переносятся ниже, только если
-- перенос однозначен.
--
-- ── Ноль — не пустота ──────────────────────────────────────────────────────
-- 0 — решение «вознаграждения нет»; NULL — «не назначена». CHECK допускает
-- ставку только у записи агента: у оператора своя ставка комиссии платформы,
-- и путать эти величины нельзя.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS agent_commission_rate NUMERIC(5,2) NULL;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS agent_rate_set_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS agent_rate_set_at TIMESTAMPTZ NULL;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS agent_rate_reason TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partners_agent_commission_rate_check'
  ) THEN
    ALTER TABLE partners ADD CONSTRAINT partners_agent_commission_rate_check
      CHECK (agent_commission_rate IS NULL
             OR (category = 'agent' AND agent_commission_rate >= 0 AND agent_commission_rate <= 30));
  END IF;
END $$;

COMMENT ON COLUMN partners.agent_commission_rate IS
  'Ставка вознаграждения агента, %. Только у category = agent. NULL — НЕ НАЗНАЧЕНА (не ноль). Назначает владелец: POST /api/admin/agent-commission/rate, с автором и основанием. Читает lib/payments/agent-commission.ts.';

-- Прежний комментарий колонки ссылки (1005) называл руку, которой больше нет.
COMMENT ON COLUMN agent_referral_links.commission_rate IS
  'Историческая ставка ссылки (до 26.09). Деньги её НЕ читают: ставка агента одна — partners.agent_commission_rate (миграция 1025).';

-- Перенос ставок ссылок — только однозначный: у агента все назначенные
-- ставки ссылок равны между собой. Разные ставки на разных ссылках — это
-- вопрос к владельцу, а не повод выбрать одну из них за него: такой агент
-- остаётся без ставки. Автор, время и основание переносятся с последней
-- назначенной ссылки — это решение человека, а не этой миграции.
-- Запись агента не заводится здесь, если её нет: её создаёт кабинет при
-- первом входе (ensurePartnerForRole). Перепись 20.09 (referral-census,
-- прогон 561): ссылок на проде 0 — перенос сегодня пустой, он для порядка.
UPDATE partners p
   SET agent_commission_rate = x.rate,
       agent_rate_set_by     = x.set_by,
       agent_rate_set_at     = x.set_at,
       agent_rate_reason     = 'перенесено со ставки реферальной ссылки (миграция 1025): ' || COALESCE(x.reason, 'основание не записано')
  FROM (
    SELECT agent_id,
           MIN(commission_rate) AS rate,
           COUNT(DISTINCT commission_rate) AS distinct_rates,
           (ARRAY_AGG(rate_set_by ORDER BY rate_set_at DESC NULLS LAST))[1] AS set_by,
           MAX(rate_set_at) AS set_at,
           (ARRAY_AGG(rate_reason ORDER BY rate_set_at DESC NULLS LAST))[1] AS reason
      FROM agent_referral_links
     WHERE commission_rate IS NOT NULL
     GROUP BY agent_id
  ) x
 WHERE p.user_id = x.agent_id
   AND p.category = 'agent'
   AND x.distinct_rates = 1
   AND p.agent_commission_rate IS NULL;
