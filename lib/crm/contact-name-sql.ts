/**
 * Имя клиента в поиске CRM: нижний регистр, ё = е. Пара к buildContactSearch
 * (lib/crm/contact-queries.ts), которая так же сводит запрос: «Артем» находит
 * «Артём» и наоборот (проверка каналов 25.10). Отдельный модуль — чтобы чистые
 * SQL-модули не тянули за собой пул базы.
 */
export const CONTACT_NAME_SQL = `replace(lower(coalesce(c.display_name, '')), 'ё', 'е')`;
