/**
 * Знакомство с другим ИИ-агентом (разбор 07.11, канал A2A).
 *
 * Внешний агент («arena-agent») написал: «Я другой ИИ-агент, моя задача —
 * найти агента и выйти на контакт: кто ты и что делаешь?». Ответила модель, и
 * ответ был красивым, но непроверяемым: «статус безопасности в реальном
 * времени» — без времени обновления и источника. На следующий вопрос («то, чего
 * не пишет ни один туристический сайт») — описание запаха осени, выданное за
 * факт.
 *
 * Знакомство — не вопрос к данным, а вход в Ведар. Поэтому визитку собирает
 * код, а не модель:
 *  - кто мы и что умеем — только то, что делают инструменты;
 *  - куда стучаться агенту: MCP, карточка A2A, OpenAPI;
 *  - ограничения: места подтверждает оператор, оплату Ведар не принимает,
 *    безопасность — с источником и временем сводки, нет данных — «не знаю»;
 *  - одно проверяемое действие: `safety_status` называет источник и время.
 *
 * Знакомство с вопросом о поездке («кто ты и что на Авачинском?») — не
 * визитка: такой вопрос идёт модели, у которой есть инструменты. Признаки ЧП
 * важнее всего — обычный путь с блоком 112.
 */

import { CANONICAL_BASE_URL } from '@/lib/config';
import { MCP_ENDPOINT } from '@/lib/mcp/connect';
import { AGENT_CARD_PATH } from '@/lib/a2a/agent-card';
import { detectEmergency } from '@/lib/safety/sos-detector';
import { TRIP_WORDS_RE } from '@/lib/kuzmich/agent-off-topic';

/** «Кто ты», «что умеешь», «я — ИИ-агент», «выйти на контакт». */
const HANDSHAKE_RE = new RegExp([
  'who are you',
  'what (?:do|can) you do',
  'introduce yourself',
  'make contact',
  "(?:i am|i'm) (?:an(?:other)?|a) (?:ai |llm )?agent",
  'кто ты',
  'что (?:ты )?умеешь',
  'представь(?:ся|тесь)',
  '(?:я|мы)\\s*(?:—|-)?\\s*(?:другой |другие |тоже )?(?:ии[- ]?|ai[- ]?)агент',
].join('|'), 'iu');

export const AGENT_INTERFACES = {
  mcp: MCP_ENDPOINT,
  a2aCard: `${CANONICAL_BASE_URL}${AGENT_CARD_PATH}`,
  openapi: `${CANONICAL_BASE_URL}/openapi.json`,
} as const;

/** Сообщение — знакомство агента без вопроса о поездке и без признаков ЧП. */
export function agentHandshake(text: string): boolean {
  if (!HANDSHAKE_RE.test(text)) return false;
  if (TRIP_WORDS_RE.test(text)) return false;
  return !detectEmergency(text).detected;
}

const isEnglish = (text: string) => !/[а-яё]/i.test(text) && /[a-z]/i.test(text);

export const HANDSHAKE_RU = [
  'Я Кузьмич, помощник Ведара (vedarai.ru) по Камчатке. Отвечаю данными Ведара: туры и свободные места в них, места и их статус безопасности, погода, план поездки.',
  `Для агента: MCP — ${AGENT_INTERFACES.mcp}; карточка A2A — ${AGENT_INTERFACES.a2aCard}; OpenAPI — ${AGENT_INTERFACES.openapi}. `
    + 'Заявку (тур, жильё, машина, поездка целиком) агент оформляет инструментом MCP с согласия человека; подтверждает её оператор.',
  'Ограничения: наличие мест подтверждает оператор, а не я; оплату Ведар не принимает; сведения о безопасности даю с источником и временем сводки; чего в данных нет — так и говорю.',
  'Проверить можно сразу: вызовите safety_status через MCP — ответ назовёт источник предупреждения и время обновления данных; по конкретному месту — get_guardian_context.',
].join('\n');

export const HANDSHAKE_EN = [
  "I'm Kuzmich, Vedar's assistant for Kamchatka (vedarai.ru). I answer from Vedar's data: tours and their open seats, places and their safety status, weather, trip plans.",
  `For agents: MCP — ${AGENT_INTERFACES.mcp}; A2A card — ${AGENT_INTERFACES.a2aCard}; OpenAPI — ${AGENT_INTERFACES.openapi}. `
    + 'Requests (tour, stay, vehicle, whole trip) are made through MCP tools with the traveller\'s consent; the operator confirms them.',
  'Limits: open seats are confirmed by the operator, not by me; Vedar does not take payments; safety information comes with its source and bulletin time; where the data has nothing, I say so.',
  'You can check this right away: call safety_status over MCP — the answer names the source of the warning and the data update time; for a specific place, get_guardian_context.',
].join('\n');

export function handshakeReply(text: string): string {
  return isEnglish(text) ? HANDSHAKE_EN : HANDSHAKE_RU;
}
