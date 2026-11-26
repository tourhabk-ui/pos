/**
 * /api/ai/deepseek снят (проверка безопасности ИИ-части 26.11, слово владельца
 * «чини Карт бланш»).
 *
 * Ранний помощник «AI.Kam»: интерфейс его не звал, а любой вошедший мог слать
 * туда текст без предела длины — прямо в DeepSeek, мимо суточного стопа и без
 * redactPII. Теперь это заглушка 410.
 *
 * Сторож судит вызовом: оба метода отвечают 410 с адресом замены, сеть не
 * зовётся, ключ из окружения не отдаётся. Регулярка по исходнику — только
 * запрет: в файле нет ни модели, ни окружения, ни тела запроса.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GET, POST } from '@/app/api/ai/deepseek/route';

const saved = process.env.DEEPSEEK_API_KEY;
afterEach(() => {
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = saved;
});

describe('/api/ai/deepseek снят', () => {
  it.each([['POST', POST], ['GET', GET]] as const)('%s: 410 с адресом замены, модель не зовётся', async (_m, handler) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.DEEPSEEK_API_KEY = 'TESTKEY-' + 'z'.repeat(24);
    const res = await handler();
    expect(res.status).toBe(410);
    const text = await res.text();
    expect(text).toContain('/kuzmich');
    expect(text).not.toContain('TESTKEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('в файле нет вызова модели, окружения и тела запроса', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/ai/deepseek/route.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/fetch\(|process\.env|request\.json|@\/lib\/ai\/|api\.deepseek\.com/);
  });
});
