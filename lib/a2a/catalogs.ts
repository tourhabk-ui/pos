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

/**
 * Что известно о записи (слово владельца 14.11 «только где проверена»):
 *   - `listed` — страницу записи мы прочитали открытой всем, дата проверки
 *     в `checked`; только у такой записи наружу отдаётся ссылка;
 *   - `pending_review` — заявка подана, публикацию мы не видели. Ссылку не
 *     отдаём: страница по ней не открывалась, и агент принял бы её за запись.
 * Каталог, где страница есть, а владение не подтверждено (AgentPeering:
 * «Ownership: Not verified»), сюда не вносится вовсе.
 */
export type A2aListing = 'listed' | 'pending_review';

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
  listing: A2aListing;
  /** Когда и чем проверено состояние записи. */
  checked: string;
}

export const A2A_REGISTRY_AGENT_ID = '538d68a1-16a1-4e55-af5a-8d672b6f1ac7';

/**
 * Запись в a2a-registry.org (с дефисом — другой реестр, не a2aregistry.org).
 * Прочитана пробой с раннера 14.11 около 11:06 UTC (прогон Actions
 * 43588386053): страница отвечает 200, «Vedar Kamchatka ·
 * ru.vedarai.___vedar_kamchatka · Registered: Oct 18, 2026 · DNS Verified».
 */
export const A2A_DASH_REGISTRY_AGENT_ID = 'ru.vedarai.___vedar_kamchatka';

export const A2A_CATALOGS: readonly A2aCatalogEntry[] = [
  {
    catalog: 'A2A Registry (a2a-registry.org)',
    id: A2A_DASH_REGISTRY_AGENT_ID,
    url: `https://www.a2a-registry.org/agent/${A2A_DASH_REGISTRY_AGENT_ID}`,
    registered_at: '2026-10-18',
    status_at_registration: 'dns_verified',
    listing: 'listed',
    checked: '2026-11-14: страница записи открыта, «DNS Verified»',
  },
  {
    catalog: 'A2A Registry (a2aregistry.org)',
    id: A2A_REGISTRY_AGENT_ID,
    url: `https://a2aregistry.org/agents/${A2A_REGISTRY_AGENT_ID}`,
    registered_at: '2026-10-12',
    status_at_registration: 'under_review',
    listing: 'pending_review',
    checked: '2026-11-09: запись не открылась, заявка на проверке',
  },
] as const;

/**
 * Запись каталога для манифеста и llms.txt: ссылка — только у записи, которую
 * мы прочитали открытой (`listed`).
 */
export function publicCatalogEntry(c: A2aCatalogEntry): Omit<A2aCatalogEntry, 'url'> & { url?: string } {
  const { url, ...rest } = c;
  return c.listing === 'listed' ? { ...rest, url } : rest;
}

/** Строка о каталоге словами — для llms.txt и людей. */
export function catalogLine(c: A2aCatalogEntry): string {
  const date = c.registered_at.split('-').reverse().join('.');
  return c.listing === 'listed'
    ? `${c.catalog} — запись ${c.id} (${c.url}), проверена ${c.checked.slice(0, 10).split('-').reverse().join('.')}`
    : `${c.catalog} — заявка подана ${date}, id ${c.id}; запись на проверке реестром, публичной страницы нет`;
}
