/**
 * tests/unit/chat-role-from-login.test.ts
 *
 * Роль собеседника веб-чата — из входа, а не из тела запроса (10.11).
 * Правило — lib/ai/chat-role; что оно закрывает на роуте (агент платформы
 * для присланной роли admin), держит tests/unit/ai-chat-kuzmich-brain.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { effectiveChatRole, CHAT_ROLES } from '@/lib/ai/chat-role';

describe('effectiveChatRole', () => {
  it('туристом назваться можно всегда — и анониму, и любому вошедшему', () => {
    expect(effectiveChatRole('tourist', null)).toEqual({ role: 'tourist', downgraded: false });
    expect(effectiveChatRole('tourist', 'admin')).toEqual({ role: 'tourist', downgraded: false });
  });

  it('роль не названа или неизвестна — турист, и это не подмена', () => {
    expect(effectiveChatRole(undefined, null)).toEqual({ role: 'tourist', downgraded: false });
    expect(effectiveChatRole('superuser', 'admin')).toEqual({ role: 'tourist', downgraded: false });
  });

  it('любая не-туристская роль — только та, что во входе', () => {
    for (const role of CHAT_ROLES.filter((r) => r !== 'tourist')) {
      expect(effectiveChatRole(role, role), role).toEqual({ role, downgraded: false });
      expect(effectiveChatRole(role, null), `${role} без входа`).toEqual({ role: 'tourist', downgraded: true });
      expect(effectiveChatRole(role, 'tourist'), `${role} у туриста`).toEqual({ role: 'tourist', downgraded: true });
    }
  });

  it('администратор по входу не становится оператором по просьбе тела', () => {
    expect(effectiveChatRole('operator', 'admin')).toEqual({ role: 'tourist', downgraded: true });
  });
});
