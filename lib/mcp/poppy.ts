/**
 * Документ обнаружения Poppy 1.0 (Personal Agent Protocol) —
 * `/.well-known/poppy.json` (#3459, слово владельца 16.11 «и потом 3459»).
 *
 * Личный агент (Meta Muse и другие по Poppy) на каждом сайте сначала ищет
 * этот файл. Спецификация: https://personalagentprotocol.org/docs/1.0/spec,
 * раздел 3 (Discovery), 3.1 — поля документа; раздел 7 — типы API.
 *
 * Только поля 3.1, и только те, что у нас есть на деле:
 *  - `protocol_version` — «1.0» (обязательно);
 *  - `organization` — `name` и `domain` (обязательны). `domain` — хост, который
 *    отдаёт документ (3.1), берётся из того же адреса, что и ссылки;
 *    `logo_uri` необязателен и не ставится;
 *  - `apis` — один пункт типа `mcp` (раздел 7: удалённый MCP-сервер по
 *    Streamable HTTP, MCP 2025-06-18 и новее — наш `/api/mcp` такой,
 *    lib/mcp/protocol-version) с `url` и коротким `description`.
 * Нет `auth`, `agent`, `web`, `tasks`, `extensions`, `supported_versions`:
 * входа по OAuth для личных агентов, своего агента по Poppy, задач и
 * разговоров у Ведара нет, и документ этого не обещает. Хватает одного из
 * `agent`/`apis`/`web` — у нас `apis`.
 *
 * Описание не обещает брони: Ведар — информационный портал, заявка уходит
 * оператору и не бронь, а отправляет её сам человек со своего согласия
 * (правила сервера, lib/mcp/server-instructions).
 */
import { getPublicBaseUrl } from '@/lib/config';

export const POPPY_PATH = '/.well-known/poppy.json';
export const POPPY_PROTOCOL_VERSION = '1.0';
export const POPPY_ORGANIZATION_NAME = 'Ведар Камчатка';

export const POPPY_MCP_DESCRIPTION =
  'Ведар — информационный портал о Камчатке: туры с реальной занятостью, безопасность мест, '
  + 'жильё, трансферы, погода. Заявка оператору — не бронь; отправляет её только сам человек, '
  + 'со своего согласия.';

export interface PoppyDocument {
  protocol_version: string;
  organization: { name: string; domain: string };
  apis: Array<{ type: 'mcp'; url: string; description: string }>;
}

export function buildPoppyDocument(baseUrl: string = getPublicBaseUrl()): PoppyDocument {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    protocol_version: POPPY_PROTOCOL_VERSION,
    organization: {
      name: POPPY_ORGANIZATION_NAME,
      // 3.1: хост, отдающий документ, с портом, только когда он не 443.
      domain: new URL(base).host,
    },
    apis: [{ type: 'mcp', url: `${base}/api/mcp`, description: POPPY_MCP_DESCRIPTION }],
  };
}
