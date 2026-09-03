/**
 * AI-дайджест уходит в канал с обложкой.
 *
 * Скрин владельца 02.09: выпуск «AI-дайджест · 2 сентября» (Switchyard, Astra)
 * стоял в ленте @ai_hub_money голым текстом среди постов с картинкой. Новости
 * того же канала (postAINewsToChannel) обложку получают через
 * resolveCoverImage, а дайджест слался через sendMessage и обложки не имел
 * никогда.
 *
 * Обложка идёт превью ссылки над текстом (link_preview_options), а не
 * sendPhoto: подпись к фото у ботов — 1024 знака, дайджест длиннее.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestHeadlines } from '@/lib/agents/scout-digest';

const DIGEST = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');
const CODE = DIGEST.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('обложка дайджеста', () => {
  it('выпуск в AI-канал получает обложку тем же путём, что новости канала', () => {
    expect(CODE).toMatch(/resolveCoverImage\(\s*digestHeadlines\(aiDigest\),\s*'ai'/);
    // Обложка передаётся в отправку, исход отправки по-прежнему присваивается.
    expect(CODE).toMatch(/aiSent = await tgSendRich\([^)]*cover\.url\)/);
  });

  it('обложка — превью над полным текстом, а не подпись к фото', () => {
    expect(CODE).toMatch(/link_preview_options/);
    expect(CODE).toMatch(/prefer_large_media: true/);
    expect(CODE).toMatch(/show_above_text: true/);
    // Устаревший флаг превью ушёл вместе с прежним поведением.
    expect(CODE).not.toMatch(/disable_web_page_preview: false/);
  });
});

describe('тема обложки — заголовки выпуска', () => {
  const html = `<b>AI-дайджест · 2 сентября</b>

<b>Switchyard: Rust-прокси для маршрутизации LLM-трафика</b>
Вышел Switchyard.
<b>Почему важно:</b> переключение без переписывания кода.
<a href="https://example.com/a">Читать →</a>

<b>Astra: OpenAI тестирует зацикленный трансформер</b>
Текст.
<b>Почему важно:</b> вывод.`;

  it('шапка с датой и «Почему важно» темой не считаются', () => {
    const t = digestHeadlines(html);
    expect(t).toBe('Switchyard: Rust-прокси для маршрутизации LLM-трафика. Astra: OpenAI тестирует зацикленный трансформер');
    expect(t).not.toMatch(/AI-дайджест/);
    expect(t).not.toMatch(/Почему важно/);
  });

  it('без жирных строк тема — начало текста без тегов', () => {
    const t = digestHeadlines('<i>Вышел</i> Switchyard — прокси.\n\n<a href="x">Читать</a>');
    expect(t).toBe('Вышел Switchyard — прокси. Читать');
    expect(t).not.toMatch(/</);
  });
});
