import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { budgetAlertText } from '@/lib/telegram/admin-notify';

describe('тревога о бюджете LLM ведёт туда, где расход', () => {
  const text = budgetAlertText(20.019, 5);
  it('числа тревоги на месте', () => {
    expect(text).toContain('$20.0190');
    expect(text).toContain('$5.00');
    expect(text).toContain('$15.0190');
  });
  it('ссылка — на страницу «Расходы AI», и такая страница есть', () => {
    const href = /href="https:\/\/vedarai\.ru(\/[^"]*)"/.exec(text)?.[1];
    expect(href).toBe('/hub/admin/ai-usage');
    expect(existsSync(`app${href}/page.tsx`)).toBe(true);
  });
  it('раздела «Статистика LLM» нет — тревога в него не зовёт', () => {
    expect(text).not.toMatch(/Статистика LLM/);
  });
});
