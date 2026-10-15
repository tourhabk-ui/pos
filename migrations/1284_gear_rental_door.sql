-- 1284: дверь проката — заявка под входом, согласие на ПД и чья заявка
--
-- Аудит 15.10, находка A13 (Д2-1, Д2-2), решение — вариант «а» по
-- карт-бланшу владельца: POST /api/gear/rentals закрыт за входом.
--
-- До этого дня заявка на аренду не знала ни человека, ни согласия:
--   - Edge и так пускал к /api/gear анонима только с GET, а шапка роута
--     называла дверь публичной — гость получал голый 401, вошедший проходил,
--     и его имя, телефон и почта уходили прокату без согласия, называющего
--     получателя;
--   - заявка держала единицу снаряжения бессрочно, и ограничить их число
--     на человека было не по чему — в строке не было пользователя.
--
-- Колонки:
--   user_id          — кто отправил заявку (вход обязателен с 15.10).
--                      Старые строки — NULL: «не записано», задним числом не
--                      угадывается. ON DELETE SET NULL — удалённый аккаунт не
--                      уносит заявку из учёта проката;
--   pd_consent_*     — запись согласия, типы как у 911 (leads) дословно:
--                      время, адрес, форма и версия текста. NULL у старых
--                      строк — согласия не спрашивали, это не отказ.
--
-- Индекс — под счёт открытых заявок человека (потолок 3 на 48 часов,
-- lib/gear/availability.ts): только pending, по пользователю и времени.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, ограничение — по наличию, индекс —
-- IF NOT EXISTS. Без BEGIN/COMMIT: транзакцию даёт раннер миграций.

ALTER TABLE gear_rentals
  ADD COLUMN IF NOT EXISTS user_id            UUID,
  ADD COLUMN IF NOT EXISTS pd_consent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pd_consent_ip      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS pd_consent_source  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS pd_consent_version VARCHAR(32);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'gear_rentals'::regclass
       AND conname  = 'gear_rentals_user_id_fkey'
  ) THEN
    ALTER TABLE gear_rentals
      ADD CONSTRAINT gear_rentals_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gear_rentals_user_pending
  ON gear_rentals (user_id, created_at)
  WHERE status = 'pending';

COMMENT ON COLUMN gear_rentals.user_id IS
  'Кто отправил заявку. С 15.10 (аудит A13) заявка только под входом; NULL у старых строк — не записано.';
COMMENT ON COLUMN gear_rentals.pd_consent_at IS
  'Когда дано согласие на обработку ПД и передачу прокату. NULL — согласие не зафиксировано (не отказ).';
COMMENT ON COLUMN gear_rentals.pd_consent_ip IS 'Адрес, с которого дано согласие.';
COMMENT ON COLUMN gear_rentals.pd_consent_source IS 'Форма, где дано согласие: gear-page.';
COMMENT ON COLUMN gear_rentals.pd_consent_version IS 'Версия формулировки согласия (lib/legal/pd-consent.ts, вариант gear).';
