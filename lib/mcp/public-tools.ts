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

/**
 * create_booking_request — заявка на бронь КОНКРЕТНОГО тура на дату
 * (Эволюция 3.0, п.4 — MCP-бронирование, владелец 08.08: «делай»).
 *
 * Это ЗАЯВКА, не бронь: исполнение проверяет реальную занятость на дату
 * (движок планера — тот же расчёт, что у гейта брони) и создаёт лид через
 * общий createLead() (скоринг, дедуп, уведомление менеджеру). Оператор
 * подтверждает голосом/чатом; слоты фантомными бронями не блокируются,
 * платёжный контур не задет.
 */
export const BOOKING_REQUEST_TOOL = {
  name: 'create_booking_request',
  description: 'Заявка на бронь конкретного тура на дату. Перед вызовом проверь свободные даты через get_tour_availability. Заявку подтверждает оператор по телефону — это не мгновенная бронь и не оплата. Если на дату нет мест, заявка не создаётся и в ответе будут ближайшие свободные даты.',
  inputSchema: {
    type: 'object',
    properties: {
      tour: { type: 'string', description: 'Название тура или числовой ID (из get_tours / get_tour_availability)' },
      date: { type: 'string', description: 'Дата тура, YYYY-MM-DD' },
      participants: { type: 'string', description: 'Сколько человек (1–30). Не сказано — 1.' },
      name: { type: 'string', description: 'Имя туриста' },
      phone: { type: 'string', description: 'Телефон для подтверждения (обязателен)' },
      comment: { type: 'string', description: 'Пожелания, вопросы, состав группы' },
    },
    required: ['tour', 'date', 'name', 'phone'],
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
  BOOKING_REQUEST_TOOL,
];

export const PUBLIC_MCP_TOOL_NAMES = new Set(PUBLIC_MCP_TOOLS.map((t) => t.name));

export const MCP_SERVER_INFO = {
  name: 'vedar-mcp',
  version: '2.2.0',
  description: 'Ведар — данные Камчатки: обстановка в крае и безопасность мест, туры и их реальная занятость, жильё, снаряжение, трансферы, погода, план поездки. Записи две: заявка на подбор (create_lead) и заявка на бронь тура на дату (create_booking_request) — обе подтверждает человек.',
} as const;
