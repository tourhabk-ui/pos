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
 * ARD (Agentic Resource Discovery, agenticresourcediscovery.org/spec) —
 * преемник AI Catalog. Его путь — /.well-known/ard.json; старый путь
 * ai-catalog.json потребитель читать не обязан (§5.1). Так же их читает
 * проверка «Агентный просмотр» Lighthouse 13 (аудит ard-schema): сначала
 * ard.json, потом старый путь с предупреждением. Документ один на оба пути.
 * У каждой записи ARD требует `displayName` (20.11 PageSpeed назвал схему
 * недействительной именно из-за него) и советует 2–5 `representativeQueries`
 * — по ним реестр строит поиск. Название берётся из самого артефакта
 * (server.json, визитка A2A), второй копии нет.
 *
 * Оба документа собираются из server.json (тот же текст, что в реестре MCP) и констант A2A: вторая копия имени или версии разошлась бы.
 * Сторож: tests/unit/agent-discovery-cards.test.ts.
 */

import manifest from '@/server.json';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';
import { AGENT_CARD_PATH, A2A_AGENT_NAME, A2A_PROTOCOL_VERSION } from '@/lib/a2a/agent-card';

/** Адрес карточки — суффикс к Streamable HTTP URL, как велит расширение. */
export const SERVER_CARD_PATH = '/api/mcp/server-card';
export const AI_CATALOG_PATH = '/.well-known/ai-catalog.json';
/** Путь ARD — преемник ai-catalog.json, тот же документ (§5.1 спецификации). */
export const ARD_PATH = '/.well-known/ard.json';

export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
export const AI_CATALOG_MEDIA_TYPE = 'application/ai-catalog+json';
export const A2A_CARD_MEDIA_TYPE = 'application/a2a-agent-card+json';
export const AI_CATALOG_SPEC_VERSION = '1.0';
/** Медиатип документа на ard.json: спецификация своего не вводит, это JSON. */
export const ARD_MEDIA_TYPE = 'application/json';
/** Базовый контекст записи ARD v0.91 (§4.1). */
export const ARD_CONTEXT = 'https://agenticresourcediscovery.org/context/v1';

/**
 * Примеры вопросов, на которые отвечает артефакт (ARD §4.2: 2–5 штук). Это
 * то, что инструменты делают на деле: туры с местами по календарю, статус
 * места и вулкана, план поездки. Без обещаний сверх ответа инструментов.
 */
export const MCP_REPRESENTATIVE_QUERIES = [
  'Kamchatka tours with free seats on a given date',
  'Is it safe to climb Avachinsky volcano today',
  'Volcano and earthquake status in Kamchatka',
  'Туры на Камчатке со свободными местами на дату',
] as const;

export const A2A_REPRESENTATIVE_QUERIES = [
  'Plan a week-long trip to Kamchatka',
  'What to know before hiking to a Kamchatka volcano',
  'Спланировать поездку на Камчатку на неделю',
] as const;

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
  /** Базовый контекст ARD (§4.1): запись читается и общим JSON-LD-инструментом. */
  '@context': typeof ARD_CONTEXT;
  identifier: string;
  /** Обязательно по ARD: без него Lighthouse считает схему недействительной. */
  displayName: string;
  type: string;
  url: string;
  version?: string;
  tags?: string[];
  representativeQueries: string[];
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
        '@context': ARD_CONTEXT,
        identifier: `urn:air:${URN_PUBLISHER}:mcp:vedar`,
        displayName: manifest.title,
        type: SERVER_CARD_MEDIA_TYPE,
        url: `${b}${SERVER_CARD_PATH}`,
        version: manifest.version,
        tags: ['kamchatka', 'travel', 'tours', 'safety', 'mcp'],
        representativeQueries: [...MCP_REPRESENTATIVE_QUERIES],
      },
      // Одна запись на агента (20.11): identifier в ARD — «глобально
      // уникальный» ключ (§4.2), и две записи с одним identifier реестр
      // свёл бы в одну. Визитка A2A 0.3 (/.well-known/agent.json) по-прежнему
      // отдаётся и названа в mcp.json и api-catalog; в каталоге — версия 1.0.
      {
        '@context': ARD_CONTEXT,
        identifier: `urn:air:${URN_PUBLISHER}:a2a:kuzmich`,
        displayName: A2A_AGENT_NAME,
        type: A2A_CARD_MEDIA_TYPE,
        url: `${b}${AGENT_CARD_PATH}`,
        version: A2A_PROTOCOL_VERSION,
        tags: ['kamchatka', 'travel', 'assistant', 'a2a'],
        representativeQueries: [...A2A_REPRESENTATIVE_QUERIES],
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
