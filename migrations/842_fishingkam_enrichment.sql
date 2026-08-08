-- 842: Глубина партнёра «Камчатская рыбалка» на карточках туров 5 и 6.
--
-- Источник ВСЕХ фактов — сайт партнёра fishingkam.ru, снят целиком пробой
-- 08.08.2026 (лог Actions, run 31280880387): ни одна цифра не выдумана.
-- Контекст — сравнительный аудит владельца 08.08: «карточка сильнее средней
-- витрины, но упущена глубина партнёра как базы». Зимние/весенние туры
-- намеренно НЕ создаются (слово владельца) — только глубина летних 5 и 6.
--
-- Идемпотентно: каждая часть с guard.

-- 1. Реквизиты партнёра: сайт, почта, адрес (низ сайта партнёра).
UPDATE partners
   SET contacts = COALESCE(contacts, '{}'::jsonb) || jsonb_build_object(
         'website', 'https://fishingkam.ru',
         'email',   'fishingkam@yandex.ru',
         'address', 'Камчатский край, г. Елизово, ул. Гагарина, д. 4'
       ),
       updated_at = NOW()
 WHERE name ILIKE '%камчатская рыбалка%'
   AND (contacts->>'website' IS DISTINCT FROM 'https://fishingkam.ru'
     OR contacts->>'email'   IS DISTINCT FROM 'fishingkam@yandex.ru'
     OR contacts->>'address' IS DISTINCT FROM 'Камчатский край, г. Елизово, ул. Гагарина, д. 4');

-- 2. Минимальная группа — 5 человек (сайт: «Минимальная группа — 5 человек»).
UPDATE operator_tours ot
   SET min_participants = 5,
       updated_at = NOW()
 WHERE ot.id IN (5, 6)
   AND ot.deleted_at IS NULL
   AND ot.operator_id = (SELECT id FROM partners WHERE name ILIKE '%камчатская рыбалка%' LIMIT 1)
   AND COALESCE(ot.min_participants, 0) <> 5;

-- 3. Условия с цифрами и порогами в «не входит» — частая причина отвала
--    на заявке, когда турист узнаёт о них постфактум.
UPDATE operator_tours ot
   SET not_included = COALESCE(ot.not_included, '{}') || ARRAY[
         'Трансфер до базы и обратно — отдельно, от 7 000 ₽ (зависит от сезона и транспорта)',
         'Одежда и обувь для рыбалки — свои (подскажем, что взять по сезону)',
         'Повар — по договорённости'
       ],
       updated_at = NOW()
 WHERE ot.id IN (5, 6)
   AND ot.deleted_at IS NULL
   AND ot.operator_id = (SELECT id FROM partners WHERE name ILIKE '%камчатская рыбалка%' LIMIT 1)
   AND NOT (COALESCE(ot.not_included, '{}') @> ARRAY['Трансфер до базы и обратно — отдельно, от 7 000 ₽ (зависит от сезона и транспорта)']);

-- 4. База как продукт: турист должен понимать, ГДЕ он спит за эти деньги.
--    Абзац — пересказ раздела «Размещение» сайта партнёра, без украшательств.
UPDATE operator_tours ot
   SET description = COALESCE(ot.description, '') ||
         E'\n\nРазмещение — собственная база партнёра: двухэтажный корпус 400 м². ' ||
         'На первом этаже — холл, кухня и столовая, раздельные туалет и душевая. ' ||
         'На втором — номера: семейный четырёхместный, номер с двуспальной кроватью ' ||
         'и четыре двухместных; совмещённые санузлы и зона отдыха.',
       updated_at = NOW()
 WHERE ot.id IN (5, 6)
   AND ot.deleted_at IS NULL
   AND ot.operator_id = (SELECT id FROM partners WHERE name ILIKE '%камчатская рыбалка%' LIMIT 1)
   AND COALESCE(ot.description, '') NOT LIKE '%400 м²%';

-- 5. Программа дня → аккордеон карточки и itinerary в JSON-LD.
--    Тексты собраны из сайта партнёра: гид и выезды, виды рыб по сезону,
--    уха на берегу, вечер на базе. Честность сохранена: чавыча у партнёра
--    помечена «не гарантирована» — так и пишем. Ставим только там, где
--    программы ещё нет — операторскую правку не перетираем.
UPDATE operator_tours ot
   SET program = '[
         {"title": "Выезд на реку с гидом", "text": "Опытный гид везёт к рыбным местам; частота выездов зависит от маршрута — в пик сезона ежедневно."},
         {"title": "Рыбалка", "text": "Кижуч, микижа (радужная форель), хариус, кунжа, голец — спиннинг или нахлыст, под ваш уровень подготовки."},
         {"title": "Уха на берегу", "text": "Гиды помогут приготовить уху из свежего улова прямо на берегу реки."},
         {"title": "Вечер на базе", "text": "Возвращение в двухэтажный корпус: кухня-столовая, душ, разбор улова и планы на завтра."}
       ]'::jsonb,
       updated_at = NOW()
 WHERE ot.id = 6
   AND ot.deleted_at IS NULL
   AND ot.operator_id = (SELECT id FROM partners WHERE name ILIKE '%камчатская рыбалка%' LIMIT 1)
   AND (ot.program IS NULL OR jsonb_array_length(ot.program) = 0);

UPDATE operator_tours ot
   SET program = '[
         {"title": "Выезд на реку с гидом", "text": "Опытный гид везёт к рыбным местам; частота выездов зависит от маршрута — в пик сезона ежедневно."},
         {"title": "Рыбалка", "text": "Нерка, микижа (радужная форель), хариус, кунжа, голец; чавыча возможна, но не гарантирована — так честно пишет сам партнёр."},
         {"title": "Уха на берегу", "text": "Гиды помогут приготовить уху из свежего улова прямо на берегу реки."},
         {"title": "Вечер на базе", "text": "Возвращение в двухэтажный корпус: кухня-столовая, душ, разбор улова и планы на завтра."}
       ]'::jsonb,
       updated_at = NOW()
 WHERE ot.id = 5
   AND ot.deleted_at IS NULL
   AND ot.operator_id = (SELECT id FROM partners WHERE name ILIKE '%камчатская рыбалка%' LIMIT 1)
   AND (ot.program IS NULL OR jsonb_array_length(ot.program) = 0);
