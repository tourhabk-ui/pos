/**
 * Модель DeepSeek не хардкодится в вызовах — она резолвится из /v1/models.
 *
 * 26.07.2026 DeepSeek вывел из эксплуатации алиас deepseek-chat: API стал
 * отвечать HTTP 400 «The supported API model names are deepseek-v4-pro or
 * deepseek-v4-flash». Весь прямой путь DeepSeek (waterfall, health-пробы,
 * tools, debug) хардкодил этот алиас — и лёг целиком в момент смены линейки.
 * «Вечных» алиасов у провайдеров не бывает: рабочий путь — спросить /v1/models
 * (resolveDeepSeekModel, кэш 1ч, override DEEPSEEK_MODEL).
 *
 * Тест запрещает возврат хардкода: литерал модели DeepSeek не должен
 * появляться в поле model ни одного запроса. Разрешённые места — таблица цен
 * (исторические строки llm_usage_log), DECISION_FALLBACK (крайний фоллбэк,
 * когда /v1/models недоступен — задокументирован как протухающий) и
 * синхронный lib/config.ts (не может await, есть env-override).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const FILES = [
  'lib/ai/providers.ts',
  'app/api/ai/health/route.ts',
  'app/api/ai/deepseek/route.ts',
];

describe('модель DeepSeek резолвится, а не хардкодится', () => {
  it.each(FILES)('%s: нет model: с литералом deepseek-*', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf-8');
    // Поле model с литеральным id DeepSeek — признак возврата хардкода.
    // deepseek/... (через слэш) — id OpenRouter, это другой провайдер.
    const offenders = [...src.matchAll(/model:\s*'(deepseek-[a-z0-9-]+)'/g)]
      .map((m) => m[1])
      .filter((id) => !id.startsWith('deepseek/'));
    expect(offenders, `хардкод модели DeepSeek в ${file}: ${offenders.join(', ')}`).toEqual([]);
  });

  it('резолвер существует и объявляет override через env', () => {
    const src = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');
    expect(src).toMatch(/export async function resolveDeepSeekModel/);
    expect(src).toMatch(/DEEPSEEK_MODEL/);
  });

  it('прямые вызовы DeepSeek идут через резолвер', () => {
    const src = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');
    // Как минимум: callDeepSeek, tools-вариант, key-проба, net-diag, debug.
    const uses = src.match(/resolveDeepSeekModel\(\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
  });
});
