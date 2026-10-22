/**
 * /api/ai/health снят (аудит перед запуском, 22.10).
 *
 * Отладочный роут, открытый в реестре публичных, пускал по токену из строки
 * запроса, а токен лежал литералом в самом файле — в публичном репозитории.
 * Предъявивший получал начало ключей четырёх провайдеров и платные вызовы
 * моделей за наш счёт без ограничения частоты. Звал его никто.
 *
 * Теперь это заглушка 410. Сторож судит вызовом: ответ 410 с адресом
 * замены, ни одного сетевого вызова, ни следа ключа из окружения. Регулярка
 * по исходнику — только запрет: чтения строки запроса и окружения в файле нет.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GET } from '@/app/api/ai/health/route';

const KEYS = ['OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'MINIMAX_API_KEY', 'XAI_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('/api/ai/health снят', () => {
  it('отвечает 410 с адресом замены, провайдеров не зовёт и ключей не отдаёт', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const k of KEYS) {
      saved[k] = process.env[k];
      process.env[k] = `TESTPREFIX-${k}-` + 'q'.repeat(24);
    }

    const res = await GET();
    expect(res.status).toBe(410);
    const text = await res.text();
    expect(text).toContain('/hub/admin/health');
    expect(text).not.toContain('TESTPREFIX');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('в файле нет ни токена, ни чтения строки запроса, ни окружения', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/ai/health/route.ts'), 'utf8');
    expect(src).not.toMatch(/DEBUG_TOKEN|searchParams|process\.env|@\/lib\/ai\//);
  });
});
