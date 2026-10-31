import { describe, it, expect } from 'vitest';
import { sanitizeAsk, kuzmichAskHref, aiAskLinks, ASK_MAX_LEN } from '@/lib/kuzmich/ask-link';

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
