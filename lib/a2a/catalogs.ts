/**
 * Где визитка A2A числится — чтобы «нет в каталоге» проверялось, а не
 * гадалось (тот же приём, что MCP_CATALOGS в lib/mcp/catalogs.ts).
 *
 * Регистрация 12.10 по слову владельца «сделай нас видимыми для всех агентов
 * и A2A»: `POST https://a2aregistry.org/api/agents/register` с адресом визитки
 * 1.0 (/.well-known/agent-card.json). Реестр сам читает карточку, раз в
 * 30 минут проверяет доступность и схему, раз в сутки шлёт настоящий
 * message/send (User-Agent `A2A-Registry-TaskProbe/1.0`; при регистрации —
 * `A2A-Registry-Smoke/1.0`) — то есть в журнале A2A будут его вопросы, и это
 * не турист. Ответ реестра: HTTP 202, статус `under_review` — запись
 * появляется в списке после проверки человеком; дата и статус ниже — на
 * момент регистрации, а не сегодняшние.
 *
 * Обновление записи (`PUT /api/agents/{id}`) требует ключ администратора
 * реестра; удаление — проверку владения. Ничего из этого в коде нет.
 */

export interface A2aCatalogEntry {
  /** Название каталога для человека. */
  catalog: string;
  /** Идентификатор записи — то, чем нас ищут. */
  id: string;
  /** Страница записи. */
  url: string;
  /** Дата регистрации и статус на тот момент. */
  registered_at: string;
  status_at_registration: string;
}

export const A2A_REGISTRY_AGENT_ID = '538d68a1-16a1-4e55-af5a-8d672b6f1ac7';

export const A2A_CATALOGS: readonly A2aCatalogEntry[] = [
  {
    catalog: 'A2A Registry (a2aregistry.org)',
    id: A2A_REGISTRY_AGENT_ID,
    url: `https://a2aregistry.org/agents/${A2A_REGISTRY_AGENT_ID}`,
    registered_at: '2026-10-12',
    status_at_registration: 'under_review',
  },
] as const;
