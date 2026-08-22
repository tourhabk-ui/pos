/**
 * Kimi (Moonshot) — третий достижимый из РФ провайдер для решателя и судьи.
 *
 * Контекст: решатель эволюции и судья фактгейта ходят через DeepSeek/Qwen.
 * Когда те молчат (наблюдаемый корень) — эволюция без предложений, а после
 * «сбой судьи = отмена» (#928) Scout вообще не публикует. Kimi K3 достижим из
 * РФ (Claude/GPT — нет). Подготовка reversible: без MOONSHOT_API_KEY провайдер
 * молча выпадает, поведение прежнее.
 *
 * Сторож фиксирует: (1) хост в реестре D2 с китайской юрисдикцией и НЕ
 * domestic (ПД по-прежнему только через redactPII); (2) проводка в оба пути —
 * гонку судьи (callAIFast) и вотерфолл решателя; (3) id модели не хардкодится.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LLM_ENDPOINTS } from '@/lib/agents/compliance/provider-registry';

const providers = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

describe('Kimi зарегистрирован в реестре D2', () => {
  it('api.moonshot.ai — Китай, не domestic', () => {
    const kimi = LLM_ENDPOINTS.find((e) => e.host === 'api.moonshot.ai');
    expect(kimi, 'хост Moonshot не в реестре — D2-гард завалит билд при егрессе').toBeDefined();
    expect(kimi!.jurisdiction).toBe('China');
    expect(kimi!.domestic, 'domestic:true разрешил бы слать сырые ПД в Китай').toBe(false);
  });
});

describe('Kimi проведён в оба пути', () => {
  it('callKimi выпадает без ключа (reversible-подготовка)', () => {
    expect(providers).toMatch(/export async function callKimi[\s\S]{0,200}getMoonshotKey\(\)/);
    expect(providers).toMatch(/if \(!apiKey\) return null/);
  });

  it('включён в гонку судьи (callAIFast)', () => {
    // Правило — УЧАСТИЕ в гонке, а не написание аргументов. 22.08 ноги
    // получили опции (потолок токенов и json-формат для судьи), и сторож,
    // пришпиленный к `callKimi(messages)`, покраснел при сохранном правиле.
    const race = /const calls: Promise<string \| null>\[\] = \[([\s\S]*?)\];/.exec(providers);
    expect(race, 'массив гонки быстрой ветки не найден').not.toBeNull();
    for (const leg of ['callDeepSeek', 'callGeminiDirect', 'callKimi']) {
      expect(race![1], `${leg} выпал из гонки судьи`).toContain(`${leg}(messages`);
    }
  });

  it('в решателе НЕ участвует — решение владельца 04.08', () => {
    // «Решатель дипсик либо опус». Хвост из моделей послабее опаснее их
    // отсутствия: когда сильные молчат, ответ всё равно приходил — но от слабой
    // модели, и отличить его было нечем. Молчание честнее подмены качества.
    // Для гонки судьи (callAIFast) и прочих задач Kimi остаётся — см. выше.
    const decider = providers.match(
      /export async function callAIDecisionDetailed[\s\S]*?\n\}/,
    )?.[0] ?? '';
    expect(decider.length).toBeGreaterThan(500);
    expect(decider).not.toMatch(/getMoonshotKey\(/);
    expect(decider).not.toMatch(/MOONSHOT_BASE/);
  });

  it('id модели не хардкодится (§8): env → /v1/models → алиас', () => {
    expect(providers).toMatch(/process\.env\.MOONSHOT_MODEL/);
    expect(providers).toMatch(/pickBestModel\(ids\) \?\? MOONSHOT_FALLBACK_MODEL/);
  });
});
