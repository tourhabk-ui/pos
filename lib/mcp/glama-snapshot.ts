/**
 * Содержимое снимка для сборки на Glama (integrations/glama/server/tools.json).
 *
 * Одна функция на скрипт, который снимок пишет, и на сторожа, который сверяет
 * записанный снимок с кодом: две копии сборки снимка разошлись бы молча.
 */
import { PUBLIC_MCP_TOOLS, MCP_SERVER_INFO } from './public-tools';
import { LEGACY_PROTOCOL_VERSIONS } from './protocol-version';
import { MCP_ENDPOINT } from './connect';

export interface GlamaSnapshot {
  serverInfo: typeof MCP_SERVER_INFO;
  /** Версии рукопожатия initialize, от новой к старой. Сервер stdio — только legacy. */
  protocolVersions: string[];
  /** Адрес живого сервера с данными: его называют инструкции и отказ вызова. */
  liveEndpoint: string;
  tools: unknown[];
}

export function buildGlamaSnapshot(): GlamaSnapshot {
  // Круг через JSON: в снимок попадает ровно то, что ушло бы клиенту по сети.
  return JSON.parse(JSON.stringify({
    serverInfo: MCP_SERVER_INFO,
    protocolVersions: [...LEGACY_PROTOCOL_VERSIONS],
    liveEndpoint: MCP_ENDPOINT,
    tools: PUBLIC_MCP_TOOLS,
  })) as GlamaSnapshot;
}
