/**
 * Пик DeepSeek записан один раз, и журнал называет ответившую модель.
 *
 * Уведомление DeepSeek 09.09 (в силе с 10.09 04:00 UTC) сделало две вещи с
 * нашим кодом. Окно скидки, записанное словами в четырёх файлах как
 * «16:30–00:30 UTC», устарело разом: пик теперь 1–4 и 6–10 UTC по будням,
 * всё остальное — скидка. И запросы к Pro отдаются Flash'ем по цене Flash —
 * значит `logLLMUsage(model, …)` с запрошенным именем называет модель,
 * которая не отвечала, ровно в той таблице, поверх которой строится
 * админка с ценами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepSeekPeak, isPeakCronSlot, DEEPSEEK_PEAK_WINDOWS_UTC } from '@/lib/ai/deepseek-peak';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('окно пика DeepSeek', () => {
  it('будни: 1–4 и 6–10 UTC — пик, остальное — скидка', () => {
    // 2026-09-10 — четверг.
    expect(isDeepSeekPeak(new Date('2026-09-10T02:30:00Z'))).toBe(true);
    expect(isDeepSeekPeak(new Date('2026-09-10T06:20:00Z'))).toBe(true);  // судья
    expect(isDeepSeekPeak(new Date('2026-09-10T04:00:00Z'))).toBe(false); // граница: пик [1,4)
    expect(isDeepSeekPeak(new Date('2026-09-10T05:50:00Z'))).toBe(false); // ревью
    expect(isDeepSeekPeak(new Date('2026-09-10T17:13:00Z'))).toBe(false); // эволюция
    expect(isDeepSeekPeak(new Date('2026-09-10T22:00:00Z'))).toBe(false); // Editor
  });

  it('выходные — скидка весь день', () => {
    // 2026-09-12 — суббота, 13 — воскресенье.
    expect(isDeepSeekPeak(new Date('2026-09-12T07:00:00Z'))).toBe(false);
    expect(isDeepSeekPeak(new Date('2026-09-13T02:00:00Z'))).toBe(false);
  });

  it('слот крона судится по часу и минуте', () => {
    expect(isPeakCronSlot(6, 20)).toBe(true);
    expect(isPeakCronSlot(5, 50)).toBe(false);
    expect(isPeakCronSlot(10, 0)).toBe(false);
    expect(DEEPSEEK_PEAK_WINDOWS_UTC.length).toBe(2);
  });

  it('старое окно «16:30–00:30» нигде не повторяется словами', () => {
    // Факт записан один раз; четыре копии уже устарели разом.
    for (const p of [
      '.github/workflows/cron-editor.yml',
      '.github/workflows/cron-enrich-routes.yml',
      '.github/workflows/cron-evo.yml',
      'CLAUDE.md',
    ]) {
      const src = read(p);
      // В CLAUDE.md и cron-evo старая цифра остаётся как история — только рядом
      // со словом «устарело», не как действующее описание окна.
      const live = src.replace(/устарел[ао][^\n]*/g, '').replace(/прежняя запись[^\n]*/g, '');
      expect(live, p).not.toMatch(/16:30[–-]00:30/);
    }
  });
});

describe('журнал называет ответившую модель', () => {
  const SRC = read('lib/ai/providers.ts');

  it('есть answeredModel и он читает поле model из ответа', () => {
    expect(SRC).toMatch(/function answeredModel\(requested: string, data: unknown\): string/);
    expect(SRC).toMatch(/'model' in data/);
  });

  it('DeepSeek, OpenRouter, xAI и бесплатные ступени пишут ответившую модель', () => {
    // Ни одного logLLMUsage с голым запрошенным именем у OpenAI-совместимых
    // провайдеров: с 10.09 запрошенное и ответившее у DeepSeek расходятся.
    const bare = SRC.match(/logLLMUsage\((model|id|xaiModel|GROQ_MODEL|CEREBRAS_MODEL|MISTRAL_MODEL), data\.usage\)/g) ?? [];
    expect(bare, `голое запрошенное имя: ${bare.join(' | ')}`).toEqual([]);
    expect((SRC.match(/answeredModel\(/g) ?? []).length).toBeGreaterThanOrEqual(11);
  });
});
