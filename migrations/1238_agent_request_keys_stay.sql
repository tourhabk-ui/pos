-- Migration 1238: ключ статуса и у заявки на жильё (ступень 1 агентного контура, #2371)
-- Created: 2026-10-14
--
-- Владелец 14.10: «го, начни с 2451 и ключа для жилья». Сверка плана 13.10
-- нашла дыру ступени 1: три пишущих инструмента из четырёх выдают ключ
-- статуса (1220), а create_stay_request — нет. По заявке на жильё агент не
-- мог узнать ничего, а человек не мог подтвердить согласие сам: в строке
-- stay_requests стояло только утверждение агента (pd_consent_source = 'mcp').
--
-- Третья цель ключа — строка stay_requests. Ключ по-прежнему смотрит ровно в
-- одну заявку: ограничение «одна цель» переписано на три колонки. Удалили
-- заявку — ключ уходит с ней (ON DELETE CASCADE), как у лида и запроса мест.
--
-- Своего жизненного цикла у заявки на жильё нет: платформа знает, кому она
-- доставлена (1213), а ответ владелец даёт гостю звонком. Поэтому статус по
-- такому ключу говорит «передана» и не обещает «ждём ответа»
-- (lib/mcp/request-status).

BEGIN;

ALTER TABLE agent_request_keys
  ADD COLUMN IF NOT EXISTS stay_request_id UUID NULL REFERENCES stay_requests(id) ON DELETE CASCADE;

ALTER TABLE agent_request_keys DROP CONSTRAINT IF EXISTS agent_request_keys_one_target;
ALTER TABLE agent_request_keys ADD CONSTRAINT agent_request_keys_one_target
  CHECK (((lead_id IS NOT NULL)::int + (seat_request_id IS NOT NULL)::int + (stay_request_id IS NOT NULL)::int) = 1);

CREATE INDEX IF NOT EXISTS agent_request_keys_stay_idx
  ON agent_request_keys (stay_request_id) WHERE stay_request_id IS NOT NULL;

COMMENT ON COLUMN agent_request_keys.stay_request_id IS
  'Заявка на жильё (create_stay_request). Ровно одна из трёх целей ключа: lead_id, seat_request_id, stay_request_id.';

COMMIT;

-- Rollback:
-- BEGIN;
-- DELETE FROM agent_request_keys WHERE stay_request_id IS NOT NULL;
-- ALTER TABLE agent_request_keys DROP CONSTRAINT IF EXISTS agent_request_keys_one_target;
-- ALTER TABLE agent_request_keys DROP COLUMN IF EXISTS stay_request_id;
-- ALTER TABLE agent_request_keys ADD CONSTRAINT agent_request_keys_one_target
--   CHECK (((lead_id IS NOT NULL)::int + (seat_request_id IS NOT NULL)::int) = 1);
-- COMMIT;
