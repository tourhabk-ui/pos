-- Migration 1200: метки и Telegram оператора о клиенте — в клиента CRM (CRM #2325, шаг 1а-2b)
-- Created: 2026-10-10
--
-- ── Что было ──────────────────────────────────────────────────────────────
-- Старый экран «Клиенты» оператора (/api/operator/clients, удалён этим же
-- PR) хранил метки и Telegram клиента в operator_client_notes (миграция
-- 1015), ключ — пара (оператор, аккаунт туриста). Экран переехал на контакты
-- CRM (crm_contacts), где метки и заметка есть у каждого клиента. Без
-- переноса всё, что оператор пометил руками, пропало бы с экрана молча.
--
-- ── Как переносится ───────────────────────────────────────────────────────
--   * метки — объединяются с метками контакта, без повторов, не больше 20
--     (тот же предел, что у правки метки через API CRM);
--   * Telegram — отдельного поля у контакта нет, и заводить поле ради одной
--     строки, которую никто не читает, — объявление без потребителя (правило
--     10.09). Он дописывается в заметку контакта строкой «Telegram: …» —
--     там, где оператор его и увидит.
--
-- Сопоставление — строго по паре (crm_contacts.partner_id = operator_id,
-- crm_contacts.user_id = user_id). Пара не обязательно уникальна: контакты
-- склеиваются по телефону, и турист с одним аккаунтом и двумя телефонами —
-- два контакта. Тогда заметка уходит в оба: оба — этот человек у этого
-- оператора, и выбирать «главный» здесь не из чего.
-- Строка заметок, у которой контакта нет, остаётся в operator_client_notes
-- нетронутой: приписать её другому контакту по похожему имени значило бы
-- выдумать связь. Таблицу не удаляем — миграции только вперёд, и данные в ней
-- остаются источником для сверки.
--
-- Идемпотентна: повтор не дублирует ни метки, ни строку Telegram.

BEGIN;

UPDATE crm_contacts c
   SET tags = COALESCE((c.tags || ARRAY(
         SELECT DISTINCT btrim(t) FROM unnest(n.tags) AS u(t)
          WHERE btrim(t) <> '' AND btrim(t) <> ALL(c.tags)
       ))[1:20], '{}'::text[]),
       notes = CASE
         WHEN n.telegram IS NULL OR btrim(n.telegram) = '' THEN c.notes
         WHEN position(('Telegram: ' || CASE WHEN n.telegram ~ '^\d+$' THEN n.telegram ELSE '@' || n.telegram END)
                       IN coalesce(c.notes, '')) > 0 THEN c.notes
         ELSE concat_ws(E'\n', NULLIF(btrim(coalesce(c.notes, '')), ''),
                        'Telegram: ' || CASE WHEN n.telegram ~ '^\d+$' THEN n.telegram ELSE '@' || n.telegram END)
       END,
       updated_at = NOW()
  FROM operator_client_notes n
 WHERE c.partner_id = n.operator_id
   AND c.user_id = n.user_id
   AND (
         EXISTS (SELECT 1 FROM unnest(n.tags) AS u(t) WHERE btrim(t) <> '' AND btrim(t) <> ALL(c.tags))
         OR (n.telegram IS NOT NULL AND btrim(n.telegram) <> ''
             AND position(('Telegram: ' || CASE WHEN n.telegram ~ '^\d+$' THEN n.telegram ELSE '@' || n.telegram END)
                          IN coalesce(c.notes, '')) = 0)
       );

COMMENT ON TABLE operator_client_notes IS
  'Заметки оператора о клиенте (теги, Telegram) до переезда «Клиентов» на CRM. С миграции 1200 перенесены в crm_contacts (метки, заметка); экран и API больше не читают и не пишут эту таблицу.';

COMMIT;

-- Rollback: перенос объединяет метки и дописывает строку в заметку — откат
-- вычитанием не делается (метку оператор мог поставить и сам). Источник
-- остаётся в operator_client_notes нетронутым.
