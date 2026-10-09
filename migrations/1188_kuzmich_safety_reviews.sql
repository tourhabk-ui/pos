-- 1188: журнал утверждений Кузьмича о безопасности для разбора человеком (#2300).
--
-- Решение владельца 09.10: предупреждения Кузьмича не держатся до
-- подтверждения — уходят сразу, а сверяются с данными инструментов того же
-- хода детерминированно (lib/kuzmich/safety-claim-guard). Человек разбирает
-- ПОСЛЕ: каждый ответ, где Кузьмич что-то сказал о безопасности, ложится
-- сюда с вердиктом сверки, и в /hub/admin/kuzmich-safety его отмечают
-- «верно» / «ошибка».
--
-- Что хранится: отрывок ОТВЕТА Кузьмича после redactPII (телефоны и почта не
-- попадают), найденные утверждения, вердикт, имена вызванных инструментов.
-- Сообщение туриста не хранится — для разбора нужен ответ, а не вопрос, и
-- лишних ПД здесь быть не должно (pd-guard). Чат не идентифицируется.
-- Срок — 30 дней: писатель удаляет старое сам (lib/kuzmich/safety-review-log).

CREATE TABLE IF NOT EXISTS kuzmich_safety_reviews (
  id             BIGSERIAL    PRIMARY KEY,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  surface        VARCHAR(16)  NOT NULL,
  verdict        VARCHAR(16)  NOT NULL CHECK (verdict IN ('backed', 'unbacked', 'contradicted', 'unverifiable')),
  claims         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  flagged        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  tools          TEXT[]       NOT NULL DEFAULT '{}',
  reply_excerpt  TEXT         NOT NULL,
  review_mark    VARCHAR(16)  CHECK (review_mark IS NULL OR review_mark IN ('correct', 'wrong')),
  review_note    TEXT,
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kuzmich_safety_reviews_open
  ON kuzmich_safety_reviews (created_at DESC) WHERE review_mark IS NULL;

COMMENT ON TABLE kuzmich_safety_reviews IS
  'Утверждения Кузьмича о безопасности с вердиктом сверки по данным хода — для разбора человеком после (#2300), 30 дней.';
