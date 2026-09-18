/**
 * Каталоги, в которых числится наш MCP-сервер, — одним списком.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 16.09 чужие агенты сказали владельцу: «к vedarai.ru/api/mcp не обращаемся —
 * его нет в каталоге». 17–18.09 сервер опубликован в двух: официальный реестр
 * MCP (`ru.vedarai/mcp`) и Smithery (`tourhabk/vedar`). Но агент, который
 * читает нас САМИХ — манифест, llms.txt, страницу /mcp, README, — об этом не
 * узнавал: идентификаторы жили только в workflow публикации. Найти по одному
 * каталогу и не найти подтверждения у первоисточника — повод счесть запись
 * чужой или устаревшей.
 *
 * ── Что здесь ─────────────────────────────────────────────────────────────
 *
 * Имя в реестре, заголовок и английское описание — из `server.json`, того же
 * манифеста, что ушёл в реестр и которым Smithery заполняет карточку: одно
 * описание на все каталоги, второго английского текста в репозитории нет.
 * Имя в Smithery — константа здесь; сторож (`tests/unit/mcp-catalogs.test.ts`)
 * держит её равной имени в маркере публикации, потому что маркер — то, чем
 * запись реально заводится.
 */

import manifest from '@/server.json';

/** Имя в Smithery: пространство владельца `tourhabk` (не org GitHub), сервер `vedar`. */
export const SMITHERY_SERVER_NAME = 'tourhabk/vedar';

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

export const MCP_CATALOGS: readonly McpCatalogEntry[] = [
  {
    catalog: 'MCP Registry (registry.modelcontextprotocol.io)',
    name: manifest.name,
    url: `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(manifest.name)}`,
  },
  {
    catalog: 'Smithery',
    name: SMITHERY_SERVER_NAME,
    url: `https://smithery.ai/servers/${SMITHERY_SERVER_NAME}`,
    install: `npx -y smithery mcp add ${SMITHERY_SERVER_NAME}`,
  },
] as const;
