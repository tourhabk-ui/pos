import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ManualChannelPostSchema, manualPostTextHash } from '@/lib/notifications/manual-channel-post';

const text = 'Прямой рейс Харбин → Петропавловск-Камчатский по субботам. Тестовый текст поста.';

describe('ручной пост: видео', () => {
  it('схема принимает video', () => {
    expect(ManualChannelPostSchema.safeParse({ channel: 'travel', text, video: '/media/x.mp4' }).success).toBe(true);
  });
  it('видео меняет хэш дедупа', () => {
    expect(manualPostTextHash(text)).not.toBe(manualPostTextHash(text, undefined, '/media/x.mp4'));
  });
  it('видео уходит через sendVideo, без фолбэка в текст', () => {
    const src = readFileSync('lib/notifications/telegram-channel.ts', 'utf-8');
    const fn = src.slice(src.indexOf('export async function tgPostVideo'));
    expect(fn).toContain('/sendVideo');
    expect(fn.slice(0, fn.indexOf('\n}\n'))).not.toContain('tgPost(');
  });
  it('триггер видео — только в travel', () => {
    const t = JSON.parse(readFileSync('.github/triggers/channel-post.json', 'utf-8'));
    if (t.video) expect(t.channel).toBe('travel');
  });
});
