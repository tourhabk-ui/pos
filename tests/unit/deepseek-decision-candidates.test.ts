/**
 * Решатель эволюции перебирает ВСЕ пригодные модели DeepSeek, а не два хардкода.
 *
 * DeepSeek тасует линейку (v3 → v4-pro/v4-flash). Сильнейшая по резолву модель
 * замолчала (deepseek-v4-pro → 200 с пустым body, 02–03.08), а хардкод-страховка
 * deepseek-chat к тому моменту уже получала 400 «not supported». Прежний перебор
 * [primary, 'deepseek-chat'] в такой ситуации сдавался, хотя рабочая модель
 * (v4-flash) была в /models. Сторож фиксирует: кандидаты строятся из /models
 * (classifyModels — сильнейшая первой), пустой body → следующая модель,
 * account-wide ошибка (401/402/403/429) → выходим.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

// Вырезаем блок DeepSeek внутри callAIDecisionDetailed для точных проверок.
const dsBlock = src.slice(
  src.indexOf('const dsKey = getDeepSeekKey();'),
  src.indexOf('// 2) Qwen'),
);

describe('DeepSeek-кандидаты решателя строятся из /models', () => {
  it('кандидаты — из classifyModels(getProviderModelIds), сильнейшая первой', () => {
    expect(dsBlock).toContain("classifyModels(await getProviderModelIds('deepseek'))");
    expect(dsBlock).toMatch(/filter\(m\s*=>\s*m\.eligible\)/);
  });

  it('primary из резолва идёт первым, дубликаты убраны', () => {
    expect(dsBlock).toContain('new Set([primary');
  });

  it('пустой body — не приговор провайдеру: пробуем следующую модель', () => {
    expect(dsBlock).toContain('пустой ответ');
    expect(dsBlock).toMatch(/continue;/);
  });

  it('только account-wide ошибки обрывают перебор (не model-specific 400/404)', () => {
    expect(dsBlock).toMatch(/\[401,\s*402,\s*403,\s*429\]\.includes\(res\.status\)/);
  });

  it('deepseek-chat остаётся последней соломинкой на случай пустого /models', () => {
    expect(dsBlock).toContain("'deepseek-chat'");
  });
});
