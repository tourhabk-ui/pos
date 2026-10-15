-- 1260: «Местечко Камчатка» — виджет Ведара на сайте партнёра
--       (mestechkokam.ru): включить виджет и внести домен в белый список.
--
-- Владелец 15.10: «вставь в сайт местечка наш виджет». Сайт партнёра —
-- WordPress, ведёт его сторонний разработчик, поэтому строку вставляет он;
-- с нашей стороны виджет должен работать с их домена в тот же момент.
-- CORS в /api/widget/lead.js и /api/widget/chat сверяет Origin с
-- `widget_domains` (проверка по хосту и поддоменам — одной записи хватает и
-- на www), а сама выдача скрипта и форма /widget/lead-form/<slug> требуют
-- `widget_enabled`. Заявка с формы идёт с `partner_slug` и ложится в кабинет
-- партнёра, лично ему в MAX (подключён 15.10) и в рабочий чат платформы.
--
-- Приветствие чата — своё, с названием партнёра: заготовка «Привет!» из 142
-- не говорит, где человек и кто отвечает. Пишется только если партнёр ещё
-- не задал своё. Цвет кнопки не задаётся: цвета сайта партнёра не сверены,
-- выдумывать нельзя — останется акцент Ведара (lib/embed/widget-style).
--
-- Гейт по slug (из 1222), каждая часть идемпотентна; то, что партнёр или
-- администратор уже записали, не трогается.

-- 1. Домен сайта в белый список, виджет включён.
UPDATE partners
   SET widget_domains = array_append(COALESCE(widget_domains, '{}'), 'mestechkokam.ru'),
       widget_enabled = true,
       updated_at = NOW()
 WHERE slug = 'mestechko'
   AND NOT ('mestechkokam.ru' = ANY (COALESCE(widget_domains, '{}')));

UPDATE partners
   SET widget_enabled = true,
       updated_at = NOW()
 WHERE slug = 'mestechko'
   AND widget_enabled IS DISTINCT FROM true;

-- 2. Приветствие чата с именем партнёра — только поверх заготовки или пустоты.
UPDATE partners
   SET widget_config = COALESCE(widget_config, '{}'::jsonb)
                       || jsonb_build_object('greeting',
                            'Здравствуйте! Я Кузьмич, помощник платформы Ведар. Подскажу по турам «Местечка Камчатка», сезону и безопасности на маршрутах — спрашивайте.'),
       updated_at = NOW()
 WHERE slug = 'mestechko'
   AND (NULLIF(btrim(COALESCE(widget_config->>'greeting', '')), '') IS NULL
        OR widget_config->>'greeting' = 'Привет!');
