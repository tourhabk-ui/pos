-- Migration 1142: свои заходы отделяются от внешних в трёх журналах
-- Created: 2026-10-02
--
-- Владелец 02.10: «если подумать, мои заходы тоже в этой статистике». Так и
-- есть, и ничем не отделены: суточный hash от IP и UA (152-ФЗ) человека не
-- называет, значит проверки владельца с телефона и из кабинета считались
-- туристами, а его вызовы MCP из своего Claude — внешним спросом. На 12
-- карточках тура «без источника» вывод «люди приходят на прямой адрес» не
-- держится, пока свои заходы в них не отделены.
--
-- Решение — флаг is_self в каждой из трёх таблиц. Своя строка НЕ прячется
-- (пишется как и прежде), а отделяется: панели считают внешних без неё и
-- показывают своё отдельным числом. Спрятать было бы проще, но однажды
-- пропал бы и настоящий турист, которого сочли своим.
--
-- Откуда флаг: сайт — cookie vedar_self (ставится переключателем в кабинете
-- администратора, в каждом браузере отдельно); MCP — метка ?self=<MCP_SELF_TAG>
-- в адресе коннектора, сверяется с env. Задним числом разделения нет:
-- старые строки остаются is_self = FALSE, и перепись за прошлые 30 дней
-- по-прежнему смешанная — это названо в панели, а не замазано.

BEGIN;

ALTER TABLE page_views     ADD COLUMN IF NOT EXISTS is_self BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE funnel_events  ADD COLUMN IF NOT EXISTS is_self BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS is_self BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE page_views     DROP COLUMN IF EXISTS is_self;
-- ALTER TABLE funnel_events  DROP COLUMN IF EXISTS is_self;
-- ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS is_self;
-- COMMIT;
