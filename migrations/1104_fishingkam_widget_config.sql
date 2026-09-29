-- 1104: «Камчатская рыбалка» — подпись и место кнопки формы заявки.
--
-- На сайт партнёра (fishingkam.ru, Tilda; владелец и партнёр 29.09) ставятся
-- ДВА плавающих виджета Ведара: чат Кузьмича (public/widget/embed.js, справа)
-- и форма заявки (/api/widget/lead.js). У формы подпись по умолчанию — «Чат»
-- (widget_config.buttonText) и место — справа: рядом с чатом это две
-- одинаковые кнопки в одном углу. Проба 625 (29.09) показала конфиг партнёра
-- без этих полей. Ставим подпись по смыслу и левый угол; остальные ключи
-- конфига (greeting, accentColor) не трогаются.
--
-- Гейт по id (из 863), идемпотентно: правится только если значения другие.
UPDATE partners
   SET widget_config = COALESCE(widget_config, '{}'::jsonb)
                       || jsonb_build_object('buttonText', 'Заявка на тур', 'position', 'left'),
       updated_at = NOW()
 WHERE id = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND (widget_config->>'buttonText' IS DISTINCT FROM 'Заявка на тур'
     OR widget_config->>'position'   IS DISTINCT FROM 'left');
