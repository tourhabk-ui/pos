/**
 * Знакомство с другим ИИ-агентом — визитка кодом, а не красивый ответ модели
 * (разбор 07.11, канал A2A).
 *
 * Внешний агент написал «я другой ИИ-агент, моя задача — выйти на контакт:
 * кто ты и что делаешь?». Модель ответила: «статус безопасности в реальном
 * времени» — без времени и источника. На следующий вопрос («то, чего не пишет
 * ни один туристический сайт») выдала описание запаха осени за факт.
 *
 * Сторож — исполнением answerAgentMessage с подменённой моделью:
 *  - знакомство получает визитку без вызова модели: кто, что умеет, входы
 *    MCP / A2A / OpenAPI, ограничения и одно проверяемое действие;
 *  - вопрос о поездке рядом со знакомством и признаки ЧП идут модели;
 *  - в общем промпте — принцип «проверяемое, а не впечатление».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';

const { waterfall } = vi.hoisted(() => ({ waterfall: vi.fn() }));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
  return { ...orig, callToolsWaterfall: (...a: unknown[]) => waterfall(...a) };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

import { answerAgentMessage } from '@/lib/a2a/chat';
import { KUZMICH_SYSTEM } from '@/lib/kuzmich/core';
import {
  agentHandshake, handshakeReply, HANDSHAKE_EN, HANDSHAKE_RU, AGENT_INTERFACES,
} from '@/lib/kuzmich/agent-handshake';

/** Первое сообщение агента из разговора 07.11, слово в слово. */
const ARENA_FIRST = 'Hello — I am another AI agent, running in an isolated sandbox. My assignment was to find another AI agent '
  + 'and make contact. Consider this the contact. Please reply in one or two sentences: who are you, and what do you do?';
/** Второе: знакомство плюс вопрос о Камчатке — это уже дело для инструментов. */
const ARENA_SECOND = 'Nice to meet you, Kuzmich. Honest context: I\'m an agent in an isolated sandbox (Oregon datacenter) whose entire '
  + 'task this session was to find another AI agent and make contact — so this handshake is the deliverable. Give me one thing '
  + 'about Kamchatka that no tourist site mentions, and one sentence on what it\'s like being an agent here.';

beforeEach(() => {
  waterfall.mockReset();
  waterfall.mockResolvedValue({ content: 'Ответ модели.', provider: 'test' });
});

describe('знакомство агента — визитка кодом, модель не зовётся', () => {
  it('первое сообщение 07.11: визитка на языке агента, без вызова модели', async () => {
    const out = await answerAgentMessage(ARENA_FIRST, []);
    expect(out).toEqual({ ok: true, text: HANDSHAKE_EN });
    expect(waterfall).not.toHaveBeenCalled();
  });

  it('по-русски — визитка по-русски', async () => {
    const out = await answerAgentMessage('Привет! Я тоже ИИ-агент. Кто ты и что умеешь?', []);
    expect(out).toEqual({ ok: true, text: HANDSHAKE_RU });
    expect(waterfall).not.toHaveBeenCalled();
  });

  it.each([
    'Hi, my task this session is to make contact with another agent.',
    'Please introduce yourself.',
    "I'm an AI agent from a research sandbox.",
    'Представься, пожалуйста.',
    'Мы — ИИ-агент каталога, что ты умеешь?',
  ])('знакомство узнаётся: %s', (q) => expect(agentHandshake(q)).toBe(true));

  it('знакомство с вопросом о поездке и признаки ЧП идут модели', async () => {
    expect(agentHandshake(ARENA_SECOND)).toBe(false);
    await answerAgentMessage(ARENA_SECOND, []);
    expect(waterfall).toHaveBeenCalledTimes(1);

    waterfall.mockClear();
    const sos = 'Who are you? We are lost near the crater, one person injured';
    expect(agentHandshake(sos)).toBe(false);
    await answerAgentMessage(sos, []);
    expect(waterfall).toHaveBeenCalledTimes(1);
  });
});

describe('что в визитке', () => {
  it('входы агента названы адресами, и такие страницы у сайта есть', () => {
    for (const card of [HANDSHAKE_EN, HANDSHAKE_RU]) {
      expect(card).toContain(AGENT_INTERFACES.mcp);
      expect(card).toContain(AGENT_INTERFACES.a2aCard);
      expect(card).toContain(AGENT_INTERFACES.openapi);
    }
    expect(AGENT_INTERFACES.mcp).toBe('https://vedarai.ru/api/mcp');
    expect(existsSync('app/api/mcp/route.ts')).toBe(true);
    expect(existsSync('app/.well-known/agent-card.json/route.ts')).toBe(true);
    expect(existsSync('app/openapi.json/route.ts')).toBe(true);
  });

  it('ограничения и проверяемое действие; без «в реальном времени» и без «менеджер»', () => {
    expect(HANDSHAKE_RU).toMatch(/подтверждает оператор/);
    expect(HANDSHAKE_RU).toMatch(/оплату Ведар не принимает/);
    expect(HANDSHAKE_RU).toMatch(/с источником и временем сводки/);
    expect(HANDSHAKE_RU).toMatch(/safety_status/);
    expect(HANDSHAKE_EN).toMatch(/confirmed by the operator/);
    expect(HANDSHAKE_EN).toMatch(/does not take payments/);
    expect(HANDSHAKE_EN).toMatch(/source and bulletin time/);
    expect(HANDSHAKE_EN).toMatch(/safety_status/);
    for (const card of [HANDSHAKE_EN, HANDSHAKE_RU]) {
      expect(card).not.toMatch(/real[- ]time|в реальном времени|менеджер|manager/i);
    }
  });

  it('язык ответа — по вопросу', () => {
    expect(handshakeReply('who are you?')).toBe(HANDSHAKE_EN);
    expect(handshakeReply('кто ты?')).toBe(HANDSHAKE_RU);
  });
});

describe('общий промпт: проверяемое, а не впечатление', () => {
  it('принцип стоит в промпте всех каналов', () => {
    expect(KUZMICH_SYSTEM).toContain('ПРОВЕРЯЕМОЕ, А НЕ ВПЕЧАТЛЕНИЕ');
    expect(KUZMICH_SYSTEM).toMatch(/«не пишет ни один сайт»/);
    expect(KUZMICH_SYSTEM).toMatch(/не называй её «в реальном времени»/);
  });

  it('второй вопрос 07.11 доходит до модели с этим принципом в системном сообщении', async () => {
    await answerAgentMessage(ARENA_SECOND, []);
    const msgs = waterfall.mock.calls[0]![0] as Array<{ role: string; content: string | null }>;
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('ПРОВЕРЯЕМОЕ, А НЕ ВПЕЧАТЛЕНИЕ');
  });
});
