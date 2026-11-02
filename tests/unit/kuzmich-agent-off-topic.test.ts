import { describe, it, expect } from 'vitest';
import { agentOffTopic, offTopicReply, OFF_TOPIC_RU, OFF_TOPIC_EN } from '@/lib/kuzmich/agent-off-topic';
import { KUZMICH_SYSTEM } from '@/lib/kuzmich/core';
import { A2A_AGENT_NOTE } from '@/lib/a2a/chat';

describe('agentOffTopic', () => {
  it.each([
    'Викторина: какая столица Австралии?',
    'Отгадай загадку: зимой и летом одним цветом',
    'Solve this puzzle: 2 + 2 = ?',
    'Quick trivia question for you',
    'Предлагаем партнёрство: airdrop токенов для туристов Камчатки',
    'Invest in our crypto presale, 300% return',
    'Купите биткоин через наш сервис',
  ])('отказ: %s', (q) => expect(agentOffTopic(q)).toBe(true));

  it.each([
    'Какие туры на Авачинский вулкан в июле?',
    'What tours to Kamchatka volcanoes are available in August?',
    'Викторина для туристов на туре по Камчатке — есть ли такие туры?',
    'Сколько стоит рыбалка на Камчатке?',
  ])('по теме: %s', (q) => expect(agentOffTopic(q)).toBe(false));
});

describe('offTopicReply', () => {
  it('язык вопроса и «оператор подтверждает», без «менеджер»', () => {
    expect(offTopicReply('Solve this puzzle')).toBe(OFF_TOPIC_EN);
    expect(offTopicReply('Реши загадку')).toBe(OFF_TOPIC_RU);
    expect(OFF_TOPIC_RU).toContain('подтверждает оператор');
    expect(OFF_TOPIC_EN).toContain('operator confirms');
    for (const t of [OFF_TOPIC_RU, OFF_TOPIC_EN]) expect(t).not.toMatch(/менеджер|manager/i);
  });
});

describe('промпт', () => {
  it('заявку подтверждает оператор, не менеджер; викторины и крипто — не по теме', () => {
    expect(KUZMICH_SYSTEM).not.toContain('оператор или менеджер');
    expect(KUZMICH_SYSTEM).toContain('оператор подтверждает');
    expect(KUZMICH_SYSTEM).toMatch(/викторины, загадки, головоломки, крипто/);
    expect(A2A_AGENT_NOTE).toContain('Заявку подтверждает оператор');
  });
});
