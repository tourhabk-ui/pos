-- 1281: канал 'widget' у заявок, уже пришедших с формы виджета партнёра.
--
-- Находка аудита 15.10 WID-config (W2). Форма заявки виджета
-- (/widget/lead-form/<slug>) шлёт source_data.source = 'partner_widget' и не
-- шлёт source_url, а нормализатор канала (lib/leads/channel.ts) узнавал
-- виджет только по чату (source_data.type = 'widget'). Настоящие заявки с
-- сайта партнёра ложились в 'other' (с 860) или оставались NULL (до неё), и
-- отчёт партнёру и перепись воронки ценности виджета не видели.
-- Нормализатор поправлен в том же PR; здесь — уже записанные строки.
--
-- Признак — только source: согласие 'widget' (pd_consent_source) пишет и
-- форма на странице оператора на Ведаре (source 'operator_page', тот же
-- partner_slug), а она не виджет. Псевдолиды чата (type 'widget') уже
-- 'widget' с 860 и этим условием не задеваются. Канал, распознанный иначе
-- (mcp, telegram…), не перетирается: правятся только 'other' и NULL.
--
-- Триггер leads поднимет updated_at у этих строк — как у бэкфилла 860.
-- Идемпотентно: второй прогон не находит строк.
UPDATE leads
   SET source_channel = 'widget'
 WHERE source_data->>'source' = 'partner_widget'
   AND (source_channel IS NULL OR source_channel = 'other');
