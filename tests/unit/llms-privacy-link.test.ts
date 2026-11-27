// @vitest-environment node
/**
 * В /llms.txt политика конфиденциальности должна быть отдельной ссылкой
 * в навигации, а не только упоминанием в тексте про заявки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/llms.txt/route.ts'), 'utf8');

describe('llms.txt: ссылка на политику конфиденциальности', () => {
  it('в «Основных страницах» есть markdown-ссылка на /legal/privacy', () => {
    const start = SRC.indexOf('## Основные страницы');
    const end = SRC.indexOf('## AI-ассистент Кузьмич', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const nav = SRC.slice(start, end);
    expect(nav).toMatch(/\[Политика конфиденциальности\]\(\$\{BASE\}\/legal\/privacy\)/);
  });

  it('в «Контакт и API» есть прямой URL', () => {
    const start = SRC.indexOf('## Контакт и API');
    expect(start).toBeGreaterThan(0);
    expect(SRC.slice(start)).toContain('${BASE}/legal/privacy');
  });
});
