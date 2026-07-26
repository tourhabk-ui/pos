/**
 * AI-аналитика (/api/admin/ai-analytics) — устойчивость к битому запросу.
 * Было 8 запросов в одном Promise.all под общим try/catch: падение любого
 * (нет таблицы/колонки на проде) → 500 → страница «AI Кузьмич» гаснет целиком.
 * Тот же класс хрупкости, что дважды ронял админку. Теперь каждый запрос под
 * safeRows: одна пустая секция + запись в _errors вместо падения всей страницы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('app/api/admin/ai-analytics/route.ts', 'utf8');

describe('ai-analytics устойчивость', () => {
  it('все 8 источников обёрнуты в safeRows', () => {
    const calls = src.match(/safeRows</g) ?? [];
    // 1 определение функции + 8 вызовов
    expect(calls.length).toBe(9);
  });

  it('safeRows ловит ошибку и отдаёт пустые строки (не роняет Promise.all)', () => {
    expect(src).toMatch(/return \{ rows: \[\] \}/);
    expect(src).toMatch(/errors\.push/);
  });

  it('частичные ошибки видны в ответе через _errors', () => {
    expect(src).toMatch(/_errors: errors/);
  });

  it('не осталось сырых pool.query в Promise.all (все под обёрткой)', () => {
    const block = src.slice(src.indexOf('await Promise.all(['), src.indexOf('utmSources'));
    expect(block).not.toMatch(/\bpool\.query</);
  });
});
