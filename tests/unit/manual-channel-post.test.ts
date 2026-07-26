/**
 * Ручной пост в канал через бота: схема, CI-страж триггер-файла, дедуп-хэш.
 * Битый триггер-файл должен ронять CI ДО мержа, а не workflow после.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ManualChannelPostSchema,
  manualPostTextHash,
  resolveChannelId,
} from '@/lib/notifications/manual-channel-post';

describe('ManualChannelPostSchema', () => {
  const valid = { channel: 'ai', text: 'a'.repeat(100) };

  it('принимает валидный пост', () => {
    expect(ManualChannelPostSchema.safeParse(valid).success).toBe(true);
  });

  it('режет текст длиннее 1024 (лимит caption у sendPhoto)', () => {
    expect(ManualChannelPostSchema.safeParse({ ...valid, text: 'a'.repeat(1025) }).success).toBe(false);
  });

  it('отклоняет неизвестный канал', () => {
    expect(ManualChannelPostSchema.safeParse({ ...valid, channel: 'random' }).success).toBe(false);
  });
});

describe('триггер-файл channel-post.json', () => {
  const raw = readFileSync('.github/triggers/channel-post.json', 'utf8');

  it('парсится и проходит схему эндпоинта', () => {
    const parsed = ManualChannelPostSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
  });

  it('текст без эмодзи (правило каналов)', () => {
    const { text } = JSON.parse(raw) as { text: string };
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
  });
});

describe('manualPostTextHash', () => {
  it('детерминирован и различает тексты', () => {
    expect(manualPostTextHash('один')).toBe(manualPostTextHash('один'));
    expect(manualPostTextHash('один')).not.toBe(manualPostTextHash('два'));
    expect(manualPostTextHash('x')).toHaveLength(32);
  });
});

describe('resolveChannelId', () => {
  it('ai → TELEGRAM_AI_CHANNEL_ID, travel → TELEGRAM_CHANNEL_ID', () => {
    const prevAi = process.env.TELEGRAM_AI_CHANNEL_ID;
    const prevTravel = process.env.TELEGRAM_CHANNEL_ID;
    process.env.TELEGRAM_AI_CHANNEL_ID = '@ai_test';
    process.env.TELEGRAM_CHANNEL_ID = '@travel_test';
    try {
      expect(resolveChannelId('ai')).toBe('@ai_test');
      expect(resolveChannelId('travel')).toBe('@travel_test');
    } finally {
      if (prevAi === undefined) delete process.env.TELEGRAM_AI_CHANNEL_ID;
      else process.env.TELEGRAM_AI_CHANNEL_ID = prevAi;
      if (prevTravel === undefined) delete process.env.TELEGRAM_CHANNEL_ID;
      else process.env.TELEGRAM_CHANNEL_ID = prevTravel;
    }
  });
});
