/**
 * Что публичный MCP-сервер показывает наружу — один список на всех.
 *
 * Раньше набор инструментов собирался прямо в `/api/mcp/route.ts`, и это было
 * нормально, пока читатель был один. Теперь их два: сам сервер и манифест
 * `/.well-known/mcp.json`, по которому чужой агент нас находит. Два списка
 * разошлись бы в первый же день — манифест обещал бы инструменты, которых нет,
 * или молчал бы о новых.
 *
 * Инструменты берутся из реестра Кузьмича: один мозг — два протокола. Внешний
 * агент видит те же данные, что турист в чате, и не отстаёт от него.
 */

import { TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';

/**
 * Не для анонимного публичного входа: жгут внешние квоты и пишут учёт
 * использования (search_kamchatka — платный веб-поиск, search_taaft — внешний
 * каталог с трекингом).
 */
export const EXCLUDED_TOOLS = new Set(['search_kamchatka', 'search_taaft']);

/**
 * create_lead — единственный ПИШУЩИЙ инструмент наружу. Бронь и оплату
 * анонимному агенту не отдаём сознательно: чужие деньги и спам. Заявка
 * безопасна — идёт в общий createLead() со скорингом и дедупом.
 */
export const CREATE_LEAD_TOOL = {
  name: 'create_lead',
  description: 'Оставить заявку на подбор тура по Камчатке: менеджер платформы свяжется по телефону. Обязательны имя, телефон и описание запроса (даты, состав группы, интересы). Не бронь и не оплата — только заявка.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Имя туриста' },
      phone: { type: 'string', description: 'Телефон для связи (обязателен)' },
      comment: { type: 'string', description: 'Запрос: даты, сколько человек, что интересует' },
      interest: { type: 'string', description: 'Название тура/маршрута, если уже выбран' },
    },
    required: ['name', 'phone', 'comment'],
  },
} as const;

export interface PublicMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export const PUBLIC_MCP_TOOLS: PublicMcpTool[] = [
  ...Object.values(TOOL_REGISTRY)
    .filter((t) => !EXCLUDED_TOOLS.has(t.definition.function.name))
    .map((t) => ({
      name: t.definition.function.name,
      description: t.definition.function.description,
      // OpenAI-style parameters — это та же JSON-схема, что MCP inputSchema
      inputSchema: t.definition.function.parameters,
    })),
  CREATE_LEAD_TOOL,
];

export const PUBLIC_MCP_TOOL_NAMES = new Set(PUBLIC_MCP_TOOLS.map((t) => t.name));

export const MCP_SERVER_INFO = {
  name: 'vedar-mcp',
  version: '2.1.0',
  description: 'Ведар — данные Камчатки: обстановка в крае и безопасность мест, туры, жильё, снаряжение, трансферы, погода. Плюс заявка на подбор тура (create_lead).',
} as const;
