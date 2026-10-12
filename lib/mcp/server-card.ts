/**
 * Карточка MCP-сервера и AI Catalog — обнаружение по стандартам, которые
 * агенты читают до первого рукопожатия (решение владельца 12.10: «сделай нас
 * видимыми для всех агентов и A2A»).
 *
 * ── Что это ───────────────────────────────────────────────────────────────
 *
 * MCP Server Card — экспериментальное расширение MCP (SEP-2127, рабочая группа
 * Server Card; репозиторий modelcontextprotocol/experimental-ext-server-card).
 * Документ лежит по адресу `<streamable-http-url>/server-card`, у нас —
 * /api/mcp/server-card, медиатип application/mcp-server-card+json. Форма —
 * подмножество server.json: `$schema`, `name`, `version`, `description`
 * (обязательные), `title`, `websiteUrl`, `repository`, `remotes[]` с
 * `type`/`url`/`supportedProtocolVersions`. Инструменты и пакеты в карточке
 * не перечисляются по спецификации: карточка — подсказка, клиент сверяет её
 * с живым сервером.
 *
 * AI Catalog (Linux Foundation, Agent-Card/ai-catalog) — доменный список
 * артефактов на /.well-known/ai-catalog.json, медиатип
 * application/ai-catalog+json: запись на карточку MCP и на визитки A2A обеих
 * версий. Идентификаторы — URN вида urn:air:{publisher}:{namespace}:{name}.
 *
 * Оба документа собираются из server.json (тот же текст, что в реестре MCP и
 * Smithery) и констант A2A: вторая копия имени или версии разошлась бы.
 * Сторож: tests/unit/agent-discovery-cards.test.ts.
 */

import manifest from '@/server.json';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, A2A_AGENT_NAME, A2A_PROTOCOL_VERSION, A2A_LEGACY_PROTOCOL_VERSION } from '@/lib/a2a/agent-card';

/** Адрес карточки — суффикс к Streamable HTTP URL, как велит расширение. */
export const SERVER_CARD_PATH = '/api/mcp/server-card';
export const AI_CATALOG_PATH = '/.well-known/ai-catalog.json';

export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
export const AI_CATALOG_MEDIA_TYPE = 'application/ai-catalog+json';
export const A2A_CARD_MEDIA_TYPE = 'application/a2a-agent-card+json';
export const AI_CATALOG_SPEC_VERSION = '1.0';

/** Издатель в URN — домен; пространства — протоколы. */
const URN_PUBLISHER = 'vedarai.ru';

export interface ServerCard {
  $schema: string;
  name: string;
  version: string;
  title: string;
  description: string;
  websiteUrl: string;
  repository: { source: string; url: string };
  remotes: Array<{ type: 'streamable-http'; url: string; supportedProtocolVersions: string[] }>;
}

export function buildServerCard(base: string): ServerCard {
  const b = base.replace(/\/$/, '');
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: manifest.name,
    version: manifest.version,
    title: manifest.title,
    description: manifest.description,
    websiteUrl: manifest.websiteUrl,
    repository: { source: manifest.repository.source, url: manifest.repository.url },
    remotes: [
      {
        type: 'streamable-http',
        url: `${b}/api/mcp`,
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
    ],
  };
}

export interface AiCatalogEntry {
  identifier: string;
  type: string;
  url: string;
  version?: string;
  tags?: string[];
}

export interface AiCatalog {
  specVersion: string;
  host: { displayName: string; url: string };
  entries: AiCatalogEntry[];
}

export function buildAiCatalog(base: string): AiCatalog {
  const b = base.replace(/\/$/, '');
  return {
    specVersion: AI_CATALOG_SPEC_VERSION,
    host: { displayName: A2A_AGENT_NAME, url: b },
    entries: [
      {
        identifier: `urn:air:${URN_PUBLISHER}:mcp:vedar`,
        type: SERVER_CARD_MEDIA_TYPE,
        url: `${b}${SERVER_CARD_PATH}`,
        version: manifest.version,
        tags: ['kamchatka', 'travel', 'tours', 'safety', 'mcp'],
      },
      // Одна визитка A2A в двух версиях протокола: пара identifier+version уникальна.
      {
        identifier: `urn:air:${URN_PUBLISHER}:a2a:kuzmich`,
        type: A2A_CARD_MEDIA_TYPE,
        url: `${b}${AGENT_CARD_PATH}`,
        version: A2A_PROTOCOL_VERSION,
        tags: ['kamchatka', 'travel', 'assistant', 'a2a'],
      },
      {
        identifier: `urn:air:${URN_PUBLISHER}:a2a:kuzmich`,
        type: A2A_CARD_MEDIA_TYPE,
        url: `${b}${LEGACY_AGENT_CARD_PATH}`,
        version: A2A_LEGACY_PROTOCOL_VERSION,
        tags: ['kamchatka', 'travel', 'assistant', 'a2a'],
      },
    ],
  };
}

/** Слабый ETag по телу: клиент шлёт If-None-Match, хост отвечает 304. */
export function weakEtag(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `W/"${h.toString(16)}-${body.length}"`;
}
