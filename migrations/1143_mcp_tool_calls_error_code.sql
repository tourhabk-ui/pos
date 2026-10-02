-- Migration 1143: причина ошибки и имя аргумента в журнале вызовов MCP
-- Created: 2026-10-02
--
-- Владелец 02.10: «12 падений get_place_info, 5 у get_tour_details, 2 у
-- create_lead неразличимы. Писать код и короткое имя аргумента, без телефона
-- и имени. Иначе чинить нечего». До этого журнал знал только РОД ошибки
-- (error_kind): отказ пула и «место не найдено» оба читались как execution.
--
-- Три колонки, все по 40 знаков:
--   error_code — машинный код причины: no_consent, bad_phone, invalid_args,
--                tour_not_found, pg:<SQLSTATE>, timeout, tool_failed, …;
--   arg_key    — ИМЯ главного аргумента вызова (name, place, tour, date);
--   arg_value  — его ЗНАЧЕНИЕ, и только у ЧИТАЮЩИХ инструментов: имя места,
--                название тура, дата. У пишущих (create_lead,
--                create_booking_request) значение не пишется никогда — там
--                имя и телефон человека (152-ФЗ). Значение, похожее на телефон
--                или почту, у читающих тоже не пишется: проверка 29.09 видела
--                get_guardian_context с place='+79…'.

BEGIN;

ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS error_code VARCHAR(40);
ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS arg_key    VARCHAR(40);
ALTER TABLE mcp_tool_calls ADD COLUMN IF NOT EXISTS arg_value  VARCHAR(40);

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS error_code;
-- ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS arg_key;
-- ALTER TABLE mcp_tool_calls DROP COLUMN IF EXISTS arg_value;
-- COMMIT;
