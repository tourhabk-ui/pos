-- 1280: «Местечко Камчатка» — подпись кнопки и вступление формы заявки;
--       новым партнёрам колонка widget_config больше не пишет заготовку.
--
-- Находка аудита 15.10 WID-config (W1, W10), карт-бланш владельца 15.10.
--
-- На проде /api/widget/lead.js?partner=mestechko отдавал кнопку «Чат», хотя
-- она открывает ФОРМУ заявки, а форма ставила над полями имени и телефона
-- приветствие чата из 1260 («Я Кузьмич… спрашивайте»). «Чат» — не выбор
-- партнёра, а DEFAULT колонки из 142:
--   {"greeting":"Привет!","accentColor":"#D44A0C","buttonText":"Чат","position":"right"}
-- 1260 задала только приветствие, и подпись осталась заготовкой. У
-- fishingkam то же чинила 1104.
--
-- 1. buttonText «Заявка на тур» — только поверх пустоты или заготовки «Чат»:
--    подпись, которую партнёр или администратор задали сами, не трогается.
-- 2. formIntro — своё вступление ФОРМЫ, отдельно от приветствия чата; без
--    обещания срока (когда ответит партнёр, платформа не знает). Пишется
--    только если не задано.
-- 3. DEFAULT колонки — пустой объект. Заготовка 142 выглядела как выбор
--    каждого нового партнёра: «Чат» на кнопке формы и прежний акцент #D44A0C
--    (белый на нём 4,39:1, ниже AA). Читатели и так дают свои умолчания
--    (lib/embed/widget-style, /api/widget/partner); уже записанную заготовку
--    они читают как «не задано», поэтому чужие строки здесь не правятся.
--
-- Гейт по slug (из 1222), каждая часть идемпотентна. Не-объект в колонке
-- (массив) не трогается: `||` дописал бы элемент, а не ключ.

-- 1. Подпись кнопки формы заявки.
UPDATE partners
   SET widget_config = COALESCE(widget_config, '{}'::jsonb)
                       || jsonb_build_object('buttonText', 'Заявка на тур'),
       updated_at = NOW()
 WHERE slug = 'mestechko'
   AND (widget_config IS NULL OR jsonb_typeof(widget_config) = 'object')
   AND (NULLIF(btrim(COALESCE(widget_config->>'buttonText', '')), '') IS NULL
        OR widget_config->>'buttonText' = 'Чат');

-- 2. Вступление формы заявки.
UPDATE partners
   SET widget_config = COALESCE(widget_config, '{}'::jsonb)
                       || jsonb_build_object('formIntro',
                            'Оставьте заявку — «Местечко Камчатка» свяжется с вами по указанному телефону.'),
       updated_at = NOW()
 WHERE slug = 'mestechko'
   AND (widget_config IS NULL OR jsonb_typeof(widget_config) = 'object')
   AND NULLIF(btrim(COALESCE(widget_config->>'formIntro', '')), '') IS NULL;

-- 3. Новые партнёры — без заготовки.
ALTER TABLE partners ALTER COLUMN widget_config SET DEFAULT '{}'::jsonb;
