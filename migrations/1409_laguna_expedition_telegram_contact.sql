-- 1409: «Лагуна Экспедиция» — Telegram для вопросов из описания её же канала.
--
-- ── Основание ─────────────────────────────────────────────────────────────
-- Описание канала оператора t.me/laguna_expedition, которое владелец переслал
-- 08.11: «Задать вопрос: @lagunaexpedition». Это ник фирмы, не человека.
--
-- До этого 1323 копировала в `telegram_contact` номер «Лагуны Прокат»: владелец
-- 23.10 сказал «телефон такой же», и это слово про телефон. Есть ли на этом
-- номере Telegram, никто не сверял, а куда писать вопросы, оператор назвал сам.
-- Телефон на карточке остаётся тем же.
--
-- ── Чего здесь нет, и это намеренно ───────────────────────────────────────
--   • Гостиница «Голубая лагуна» из того же описания (@bluelagoonkam) не
--     трогается: её карточку владелец скрыл 10.10 словом «пока спрячем»
--     (1209), и вернуть её — его решение.
--
-- Правка оператора не перетирается: ник ставится, только если поле пусто или в
-- нём прежняя копия из «Лагуны Прокат». Повтор ничего не меняет. Исход — WARNING
-- в конце.

BEGIN;

UPDATE partners p
   SET contacts = jsonb_set(COALESCE(p.contacts, '{}'::jsonb), '{telegram_contact}', to_jsonb('lagunaexpedition'::text)),
       updated_at = NOW()
 WHERE p.slug = 'laguna-expedition'
   AND (
     NULLIF(btrim(p.contacts->>'telegram_contact'), '') IS NULL
     OR p.contacts->>'telegram_contact' = (
       SELECT lp.contacts->>'telegram_contact' FROM partners lp WHERE lp.slug = 'laguna-prokat' LIMIT 1
     )
   );

-- Исход вслух: на карточке ник из описания канала. Иное (карточки нет,
-- оператор вписал свой контакт) называется, а не молчит. Сам контакт в лог не
-- пишется: что вписал оператор, видно в карточке.
DO $$
DECLARE
  v_found boolean;
  v_contact text;
BEGIN
  SELECT TRUE, contacts->>'telegram_contact' INTO v_found, v_contact
    FROM partners WHERE slug = 'laguna-expedition';
  IF v_found IS NULL THEN
    RAISE WARNING '[1409] карточки laguna-expedition нет — Telegram ставить некуда';
  ELSIF v_contact IS DISTINCT FROM 'lagunaexpedition' THEN
    RAISE WARNING '[1409] Telegram «Лагуны Экспедиции» не ник из канала: в поле другой контакт, не копия из «Лагуны Прокат» — правку не трогали';
  END IF;
END $$;

COMMIT;
