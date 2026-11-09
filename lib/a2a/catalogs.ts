/**
 * Где визитка A2A числится — чтобы «нет в каталоге» проверялось, а не
 * гадалось (тот же приём, что MCP_CATALOGS в lib/mcp/catalogs.ts).
 *
 * a2a-registry.org (www): карточка заявлена, claimed организацией Vedar,
 * домен vedarai.ru подтверждён DNS 09.11.2026. Публичная страница:
 * https://www.a2a-registry.org/agent/ru.vedarai.___vedar_kamchatka
 *
 * a2aregistry.org (другой сайт): регистрация 12.10 по слову владельца
 * (`POST https://a2aregistry.org/api/agents/register`, id ниже) — заявка
 * удержана автомодерацией, публичной страницы нет (404). В A2A_CATALOGS
 * её нет: не числим как листинг. Id оставлен константой для журнала и docs.
 *
 * Обновление записи a2aregistry (`PUT /api/agents/{id}`) требует ключ
 * администратора реестра; удаления в коде нет.
 */

export interface A2aCatalogEntry {
  /** Название каталога для человека. */
  catalog: string;
  /** Идентификатор записи — то, чем нас ищут (package name / uuid). */
  id: string;
  /** Страница записи (живая, не 404). */
  url: string;
  /** Дата появления записи в каталоге (или claim / DNS-verify). */
  registered_at: string;
  /** Статус на момент фиксации в коде — не «сегодня». */
  status_at_registration: string;
}

/** Заявка 12.10 на a2aregistry.org — удержана модерацией, страницы нет. */
export const A2A_REGISTRY_AGENT_ID = '538d68a1-16a1-4e55-af5a-8d672b6f1ac7';

/** Package name карточки на a2a-registry.org. */
export const A2A_REGISTRY_ORG_PACKAGE = 'ru.vedarai.___vedar_kamchatka';

export const A2A_CATALOGS: readonly A2aCatalogEntry[] = [
  {
    catalog: 'A2A Registry (a2a-registry.org)',
    id: A2A_REGISTRY_ORG_PACKAGE,
    url: `https://www.a2a-registry.org/agent/${A2A_REGISTRY_ORG_PACKAGE}`,
    registered_at: '2026-11-09',
    status_at_registration: 'claimed_dns_verified',
  },
] as const;
