/**
 * Сторож проверки доступа бота в AI-канал (lib/agents/ai-channel-access.ts).
 *
 * Главное, что здесь закреплено, — РАЗЛИЧЕНИЕ «нельзя публиковать» и «не
 * смог проверить». Они ведут к разным действиям: первое чинится в Telegram
 * (добавить бота админом), второе — у нас (токен, сеть, ID). Слитые в одно,
 * они отправляют владельца не туда, а именно этим болел весь разбор
 * молчания разведчика.
 *
 * Второе: у канала право публиковать — ОТДЕЛЬНОЕ от роли админа. Админ без
 * can_post_messages молча не сможет отправить пост, и считать его «может»
 * значит вернуть ту же немоту, ради разбора которой всё делалось.
 */
import { describe, it, expect } from 'vitest';
import { readChannelAccess, describeAccess } from '@/lib/agents/ai-channel-access';

const chatOk = { ok: true, result: { title: 'AI Hub Money' } };

describe('доступ в канал: три исхода, и они не смешиваются', () => {
  it('создатель канала — публиковать может', () => {
    const a = readChannelAccess(chatOk, { ok: true, result: { status: 'creator' } });
    expect(a.kind).toBe('can_post');
    if (a.kind !== 'can_post') throw new Error('unreachable');
    expect(a.title).toBe('AI Hub Money');
  });

  it('админ С правом публикации — может', () => {
    const a = readChannelAccess(chatOk, { ok: true, result: { status: 'administrator', can_post_messages: true } });
    expect(a.kind).toBe('can_post');
  });

  it('админ БЕЗ права публикации — не может, и причина названа', () => {
    const a = readChannelAccess(chatOk, { ok: true, result: { status: 'administrator', can_post_messages: false } });
    expect(a.kind).toBe('cannot_post');
    if (a.kind !== 'cannot_post') throw new Error('unreachable');
    expect(a.reason).toMatch(/без права публиковать/);
  });

  it('админ, у которого Telegram не сообщил право — это «не знаю», а не «можно»', () => {
    // Молчание про флаг нельзя трактовать в свою пользу: пост уйдёт в никуда,
    // а отчёт будет уверять, что всё в порядке.
    const a = readChannelAccess(chatOk, { ok: true, result: { status: 'administrator' } });
    expect(a.kind).toBe('unknown');
  });

  it('бот не в канале — не может', () => {
    for (const status of ['left', 'kicked']) {
      const a = readChannelAccess(chatOk, { ok: true, result: { status } });
      expect(a.kind, `статус ${status}`).toBe('cannot_post');
    }
  });

  it('бот просто подписчик — не может', () => {
    const a = readChannelAccess(chatOk, { ok: true, result: { status: 'member' } });
    expect(a.kind).toBe('cannot_post');
    if (a.kind !== 'cannot_post') throw new Error('unreachable');
    expect(a.reason).toMatch(/member/);
  });

  it('канал не найден — это ФАКТ о доступе с текстом Telegram', () => {
    const a = readChannelAccess({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, null);
    expect(a.kind).toBe('cannot_post');
    if (a.kind !== 'cannot_post') throw new Error('unreachable');
    expect(a.reason).toContain('chat not found');
    expect(a.reason).toContain('400');
  });

  it('запрос не состоялся — «не смог проверить», а НЕ «нельзя публиковать»', () => {
    const a = readChannelAccess(null, null);
    expect(a.kind).toBe('unknown');
    const b = readChannelAccess(chatOk, null);
    expect(b.kind).toBe('unknown');
  });

  it('мусор вместо result не роняет разбор', () => {
    expect(readChannelAccess({ ok: true }, { ok: true }).kind).toBe('cannot_post');
    expect(readChannelAccess({ ok: true, result: 'строка' }, { ok: true, result: null }).kind).toBe('cannot_post');
  });
});

describe('describeAccess: исход читается без раскрытия JSON', () => {
  it('три исхода дают три разные строки', () => {
    const lines = [
      describeAccess({ kind: 'can_post', title: 'AI Hub Money' }),
      describeAccess({ kind: 'cannot_post', reason: 'бот не в канале', title: null }),
      describeAccess({ kind: 'unknown', reason: 'сеть' }),
    ];
    expect(new Set(lines).size).toBe(3);
    expect(lines[1]).toContain('НЕ может');
    expect(lines[2]).toContain('не смог проверить');
  });
});
