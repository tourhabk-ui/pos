/**
 * Каталоги, в которых числится наш MCP-сервер, — одним списком.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 16.09 чужие агенты сказали владельцу: «к vedarai.ru/api/mcp не обращаемся —
 * его нет в каталоге». 17–18.09 сервер опубликован в официальном реестре MCP
 * (`ru.vedarai/mcp`) и тогда же в Smithery (`tourhabk/vedar`). 31.10.2026
 * Smithery закрыл прокси, аккаунты и API-ключи и остался только публичным
 * реестром; карточка https://smithery.ai/server/tourhabk/vedar и
 * https://smithery.ai/new отвечают 404. Живая запись в этом списке — только
 * официальный реестр. Идентификаторы отсюда читают манифест, llms.txt,
 * страница /mcp и README: одно место, без второй копии.
 *
 * ── Что здесь ─────────────────────────────────────────────────────────────
 *
 * Имя в реестре, заголовок и английское описание — из `server.json`, того же
 * манифеста, что ушёл в реестр: одно описание на все каталоги, второго
 * английского текста в репозитории нет.
 */

import manifest from '@/server.json';

export const MCP_TITLE_EN: string = manifest.title;
export const MCP_DESCRIPTION_EN: string = manifest.description;

export interface McpCatalogEntry {
  /** Название каталога для человека. */
  catalog: string;
  /** Идентификатор записи — то, чем нас ищут. */
  name: string;
  /** Страница записи или запрос к каталогу, по которому запись видна. */
  url: string;
  /** Команда подключения в клиенте, если каталог её даёт. */
  install?: string;
}

/**
 * День, с которого сервер стоит в официальном реестре (`ru.vedarai/mcp`
 * active) и на Glama (коннектор Healthy) — сверено владельцем 18.09.2026 с
 * телефона, не по памяти. Тогда же запись была и в Smithery; 31.10.2026
 * каталог закрыл публикации, и 20.11.2026 запись убрана из этого списка.
 * От этого дня Watchdog отсчитывает окно, в котором молчание журнала
 * вызовов — сигнал «нас не нашли», а не «ещё рано».
 * Переопубликовались заново — дата двигается видимым коммитом.
 */
export const MCP_CATALOG_LAUNCH_DATE = '2026-09-18';

/**
 * Окно сигнала о молчании: раньше 7 суток агрегаторы ещё тянут реестр и
 * списки читают люди — тишина не говорит ничего; после 14 суток вопрос
 * отвечен, и повторять его дважды в день (дебаунс Watchdog 12 ч) — долбёжка
 * без нового факта. Панель /hub/admin/mcp показывает ноль и после.
 */
export const MCP_SILENCE_ALERT_FROM_DAYS = 7;
export const MCP_SILENCE_ALERT_UNTIL_DAYS = 14;

/**
 * HTTP challenge Glama для claim коннектора `ru.vedarai/mcp` (18.09).
 * Glama выдал строку владельцу на странице коннектора и просит отдавать её
 * по `/.well-known/glama.json` ПОСТОЯННО: «keep the HTTP file in place to
 * keep ownership verified» — снять роут значит потерять владение. Не секрет:
 * файл публичный по построению, доказательство — сам факт, что его отдаёт
 * наш домен. Значение переписано со снимка экрана владельца; сверено с
 * текстом, который он прислал следом.
 */
export const GLAMA_CLAIM = 'glama_claim_YRnou3wLSt5J5_X3_jmhltmIzO1thMoZ';
export const GLAMA_CONNECTOR_SCHEMA = 'https://glama.ai/mcp/schemas/connector.json';

/**
 * Подтверждение владения доменом для Appside MCP Directory (#3423): каталог
 * сам нашёл сервер и завёл карточку «Vedar (Kamchatka travel)», но открывает
 * её поисковикам только после подтверждения. Строка отдаётся файлом
 * /.well-known/appside-mcp.txt. Публичный проверочный токен, не секрет:
 * доказательство — сам факт, что его отдаёт наш домен. Файл можно оставить и
 * после подтверждения. Значение — из задачи #3423, слово в слово.
 */
export const APPSIDE_MCP_VERIFICATION = 'appside-mcp=c6e48c2f9b81644430352e601af213f5e54d42e3753560425b9712d7af3dc494';

export const MCP_CATALOGS: readonly McpCatalogEntry[] = [
  {
    catalog: 'MCP Registry (registry.modelcontextprotocol.io)',
    name: manifest.name,
    url: `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(manifest.name)}`,
  },
] as const;
