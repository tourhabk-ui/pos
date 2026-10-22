/**
 * Вход `/api/routes?place_type=` — одно правило на два места (22.10).
 *
 * Им проверяет вход схема каталога (lib/routes/catalog-query, Zod до SQL), и
 * его же `source` стоит в документе OpenAPI (lib/api/openapi) как `pattern`.
 * Второй литерал в документе разошёлся бы с первым молча: агент читал бы
 * одно правило, а сервер отвечал бы 400 по другому.
 *
 * Модуль без зависимостей намеренно: документ для агентов собирается без
 * базы (tests/unit/openapi-agents.test.ts), а catalog-query тянет пул.
 *
 * Вид места — `places.location_type`: латиница и «_», до восьми через
 * запятую (volcano; hot_spring,thermal; bay,cape,beach).
 */
export const PLACE_TYPE_PARAM = /^[a-z_]{1,40}(,[a-z_]{1,40}){0,7}$/;
