-- 840: Телефоны партнёра «Камчатская рыбалка» + часы звонков.
--
-- Источник: владелец, 08.08.2026 — «Звоните, Пн-Пт 00:00 - 10:00 по МСК:
-- +7 (999) 299-70-07, +7 (914) 782-22-22». До этого в contacts были только
-- Telegram и TikTok (834) — владелец увидел карточки рыбалки без телефонов.
-- Кнопки рендерит toContacts (phone/phone2 — как у сплавов, 822/830);
-- часы — отдельной строкой под контактами (phone_hours).
-- Часы храним в камчатском времени (МСК+9): турист звонит из тайги, не из Москвы.
--
-- Идемпотентно: guard по IS DISTINCT FROM, повторный прогон — no-op.

UPDATE partners
   SET contacts = COALESCE(contacts, '{}'::jsonb) || jsonb_build_object(
         'phone',  '+79992997007',
         'phone2', '+79147822222',
         'phone_hours', 'Пн–Пт 09:00–19:00 по Камчатке (00:00–10:00 МСК)'
       ),
       updated_at = NOW()
 WHERE name ILIKE '%камчатская рыбалка%'
   AND (contacts->>'phone'  IS DISTINCT FROM '+79992997007'
     OR contacts->>'phone2' IS DISTINCT FROM '+79147822222'
     OR contacts->>'phone_hours' IS DISTINCT FROM 'Пн–Пт 09:00–19:00 по Камчатке (00:00–10:00 МСК)');
