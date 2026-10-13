-- Migration 1233: «Шатун» — вывеской, ИП — исполнителем в реквизитах (слово владельца 13.10)
-- Created: 2026-10-13
--
-- Владелец 13.10: «Поменяй на «Шатун» а ип в карточку компании как у туров».
--
-- ── Как вывеска стала «ИП Миронова» ────────────────────────────────────────
--
-- 1185 завела перевозчика с name = 'Шатун'. 1187 записала реквизиты, в том
-- числе company_name = 'ИП Миронова Нина Васильевна'. На partners стоит
-- триггер 052 (sync_partner_company_name): изменился company_name — name
-- становится тем же. Так перевозчик на всех экранах, в ответах Кузьмича и MCP
-- и в заявках менеджеру стал называться «ИП Миронова Нина Васильевна».
--
-- ── Что здесь ──────────────────────────────────────────────────────────────
--
-- name = 'Шатун'. Триггер уравняет company_name с ним же — так у всех
-- партнёров: company_name — вывеска, юрлицо живёт в legal_info. Оттуда его и
-- читают карточка тура («Исполнитель: …», lib/tours/tour-detail-query) и с
-- этого дня страница перевозчика (lib/transfers/charter, parseLegal).
--
-- Реквизиты в legal_info записала 1187 — companyName и ИНН (слово владельца
-- 09.10, три сходящихся источника). Здесь они дописываются ТОЛЬКО если их там
-- нет: правку администратора не затираем.
--
-- Идемпотентно.

BEGIN;

UPDATE partners
   SET legal_info = COALESCE(CASE WHEN jsonb_typeof(legal_info) = 'object' THEN legal_info END, '{}'::jsonb)
                    || jsonb_build_object('companyName', 'ИП Миронова Нина Васильевна')
 WHERE slug = 'shatun'
   AND category = 'transfer'
   AND COALESCE(btrim(legal_info->>'companyName'), '') = '';

UPDATE partners
   SET legal_info = COALESCE(CASE WHEN jsonb_typeof(legal_info) = 'object' THEN legal_info END, '{}'::jsonb)
                    || jsonb_build_object('inn', '250302356113')
 WHERE slug = 'shatun'
   AND category = 'transfer'
   AND COALESCE(btrim(legal_info->>'inn'), '') = '';

UPDATE partners
   SET name = 'Шатун'
 WHERE slug = 'shatun'
   AND category = 'transfer'
   AND name IS DISTINCT FROM 'Шатун';

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE partners SET name = 'ИП Миронова Нина Васильевна' WHERE slug = 'shatun';
-- COMMIT;
