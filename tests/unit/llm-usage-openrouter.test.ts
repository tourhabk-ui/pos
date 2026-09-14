/**
 * Самая дорогая ступень тоже пишет расход (владелец 14.09: «нужно экономить
 * но без потери качества»).
 *
 * ── Что было ───────────────────────────────────────────────────────────────
 *
 * `logLLMUsage` зовут четырнадцать мест: DeepSeek, Anthropic, xAI, Kimi, Qwen,
 * Timeweb, Groq, Cerebras, Mistral — все. Не звало ровно одно:
 * `callOpenRouterModel`, разбиравшее в ответе только `choices` и проходившее
 * мимо `usage`. Через него идёт ФЛАГМАН — то есть единственная ступень, где
 * токен стоит заметных денег.
 *
 * Следствие: в `llm_usage_log` нет расхода как раз там, где он есть. Шапка
 * `lib/ai/model-cost.ts` называет это прямо — «настоящий замер станет
 * возможен, когда callOpenRouterModel начнёт писать usage: сейчас самая
 * дорогая ступень не пишет его вовсе». Панель показывала ОЦЕНКУ по формам
 * работ и честно помечала её `estimated: true`; фактом она не становилась.
 *
 * Экономить нельзя то, чего не видишь: решение «сменить модель ради цены»
 * принимается по счёту за наши прогоны, а счёт был слеп на самой дорогой
 * строке.
 *
 * ── Почему расход пишется ДО проверки текста ───────────────────────────────
 *
 * Пустой ответ тоже оплачен. Счётчик, учитывающий только удачные вызовы,
 * занижает трату ровно там, где модель капризничает, — то есть в худший
 * момент врёт в самую приятную сторону.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');
/** Код без комментариев: прежнее поведение в них описано намеренно. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Тело callOpenRouterModel — судим ступень, а не весь файл. */
const OR_MODEL = (() => {
  const start = CODE.indexOf('export async function callOpenRouterModel');
  expect(start, 'callOpenRouterModel не найден').toBeGreaterThan(-1);
  const end = CODE.indexOf('export async function', start + 10);
  expect(end).toBeGreaterThan(start);
  return CODE.slice(start, end);
})();

describe('ступень флагмана видна в счётчике', () => {
  it('расход пишется', () => {
    expect(OR_MODEL).toMatch(/logLLMUsage\(/);
  });

  it('usage действительно разбирается из ответа, а не берётся из воздуха', () => {
    // Без поля в типе `data?.usage` всегда undefined, а logLLMUsage на
    // undefined выходит сразу — проверка выше зеленела бы при мёртвом коде.
    expect(OR_MODEL).toMatch(/usage\?: ProviderUsage/);
    expect(OR_MODEL).toMatch(/logLLMUsage\(.*,\s*data\?\.usage\)/);
  });

  it('пишется имя ОТВЕТИВШЕЙ модели, а не запрошенной', () => {
    // OpenRouter маршрутизирует и может ответить не тем, что просили;
    // журнал, пишущий запрошенное имя, называет модель, которая не отвечала.
    expect(OR_MODEL).toMatch(/logLLMUsage\(answeredModel\(modelId, data\)/);
  });

  it('расход пишется ДО выхода по пустому тексту', () => {
    // Пустой ответ оплачен так же. Порядок здесь — это и есть правило.
    const log = OR_MODEL.indexOf('logLLMUsage(');
    const emptyGuard = OR_MODEL.indexOf("kind: 'empty'");
    expect(log).toBeGreaterThan(-1);
    expect(emptyGuard).toBeGreaterThan(-1);
    expect(log).toBeLessThan(emptyGuard);
  });

  it('на отказ по HTTP расход НЕ пишется', () => {
    // 401/429 токенов не тратят. Писать по ним нулевую строку значило бы
    // засорять счёт вызовами, которых не было.
    const httpGuard = OR_MODEL.indexOf('if (!res.ok)');
    const log = OR_MODEL.indexOf('logLLMUsage(');
    expect(httpGuard).toBeGreaterThan(-1);
    expect(httpGuard).toBeLessThan(log);
  });
});

describe('остальные ступени расход писать не перестали', () => {
  it('счётчик зовут все, кто ходит к провайдеру', () => {
    // Грубая, но рабочая мера: если кто-то заведёт новую ступень и забудет
    // журнал, число перестанет расти вместе с ними. Точную привязку
    // «ступень → вызов» статикой не выразить, а это — заметит.
    const calls = CODE.match(/logLLMUsage\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(14);
  });
});
