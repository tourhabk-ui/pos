/**
 * Обложки новостных постов: разные новости — разные картинки.
 * Регрессия: фиксированные промпты («neural network… digital brain» /
 * «volcanic mountains, bears…») давали визуально одну обложку на все посты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { aiNewsImagePrompt, travelNewsImagePrompt, hashStr } from '@/lib/notifications/post-image';

const SUMMARIES = Array.from({ length: 30 }, (_, i) =>
  `Новость номер ${i}: ${['MCP в продуктах', 'цены DeepSeek', 'новые правила туризма', 'рост бронирований'][i % 4]} — вариант ${i * 7}`,
);

describe('вариативность обложек', () => {
  it('30 разных новостей дают >= 10 разных сюжетных комбинаций (AI-канал)', () => {
    const prompts = new Set(SUMMARIES.map(s => aiNewsImagePrompt(s).split(', theme:')[0]));
    expect(prompts.size).toBeGreaterThanOrEqual(10);
  });

  it('30 разных новостей дают >= 6 разных сюжетов (туристический канал)', () => {
    const prompts = new Set(SUMMARIES.map(s => travelNewsImagePrompt(s).split(', theme:')[0]));
    expect(prompts.size).toBeGreaterThanOrEqual(6);
  });

  it('одна и та же новость стабильно даёт один промпт (перепост не переодевается)', () => {
    expect(aiNewsImagePrompt('MCP меняет UX')).toBe(aiNewsImagePrompt('MCP меняет UX'));
    expect(travelNewsImagePrompt('Вачкажец открыт')).toBe(travelNewsImagePrompt('Вачкажец открыт'));
  });

  it('тема новости входит в промпт', () => {
    expect(aiNewsImagePrompt('MCP меняет интерфейсы продуктов')).toContain('MCP меняет интерфейсы');
    expect(travelNewsImagePrompt('Дорога на Вачкажец открыта')).toContain('Вачкажец');
  });

  it('hashStr детерминирован и различает строки', () => {
    expect(hashStr('a')).toBe(hashStr('a'));
    expect(hashStr('a')).not.toBe(hashStr('b'));
  });
});

describe('структурно: фиксированные промпты выпилены из генераторов', () => {
  it('в telegram-channel.ts не осталось «digital brain» и «bears fishing»', () => {
    const src = readFileSync('lib/notifications/telegram-channel.ts', 'utf8');
    expect(src).not.toMatch(/abstract digital brain/);
    expect(src).not.toMatch(/bears fishing/);
    expect(src).toMatch(/aiNewsImagePrompt/);
    expect(src).toMatch(/travelNewsImagePrompt/);
  });
});
