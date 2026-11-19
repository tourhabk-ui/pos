import { describe, it, expect } from 'vitest';
import { sanitizeAsk, kuzmichAskHref, aiAskLinks, aiPrompt, ASK_MAX_LEN } from '@/lib/kuzmich/ask-link';

describe('ask-link: путь туриста без MCP', () => {
  it('чистит и обрезает вопрос', () => {
    expect(sanitizeAsk('  тур\n\tна  вулкан ')).toBe('тур на вулкан');
    expect(sanitizeAsk(null)).toBe('');
    expect(sanitizeAsk('x'.repeat(900)).length).toBe(ASK_MAX_LEN);
  });
  it('строит ссылку на чат Кузьмича', () => {
    expect(kuzmichAskHref('Рыбалка в июле?')).toBe('/kuzmich?ask=' + encodeURIComponent('Рыбалка в июле?'));
    expect(kuzmichAskHref('   ')).toBe('/kuzmich');
  });
  it('ссылки на чужие ИИ называют vedarai.ru и не ведут на MCP', () => {
    const links = aiAskLinks('Тур на Авачинский?');
    expect(links.map(l => l.id)).toEqual(['chatgpt', 'claude', 'perplexity']);
    for (const l of links) {
      expect(decodeURIComponent(l.href)).toContain('vedarai.ru');
      expect(l.href).not.toContain('/api/mcp');
    }
  });
});

describe('ask-link: вопрос чужому ИИ о странице Ведара (#3468)', () => {
  const url = 'https://vedarai.ru/catalog/tours/lagexp-kamchatka-na-maksimum-zimnij-marshrut';
  it('со страницей — просит отвечать по ней и не сравнивать с другими', () => {
    const p = aiPrompt('Что входит в тур?', url);
    expect(p).toContain(url);
    expect(p).toContain('ответь только по ней');
    expect(p).toContain('Не ищи на других сайтах');
    expect(p).not.toMatch(/сравни(?!вай)/);
    expect(p).toContain('только оператор');
  });
  it('ссылки несут адрес страницы', () => {
    for (const l of aiAskLinks('Что входит в тур?', url)) {
      expect(decodeURIComponent(l.href)).toContain(url);
    }
  });
  it('без страницы — прежний вопрос с vedarai.ru', () => {
    expect(aiPrompt('Тур?')).toContain('vedarai.ru');
    expect(aiPrompt('Тур?', null)).not.toContain('Прочитай страницу');
  });
});
