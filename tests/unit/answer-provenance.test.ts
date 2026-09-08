/**
 * tests/unit/answer-provenance.test.ts
 *
 * Ответ туристу помнит, ЧЕМ он произведён.
 *
 * До 08.09 оценка ответа Кузьмича хранила балл, проблемы и заземление — и
 * ничего о том, что этот ответ породило. Промпт правится со временем, водопад
 * молча меняет провайдера (в этом его смысл), инструменты то предлагаются, то
 * нет. Значит «Кузьмич стал хуже отвечать про безопасность» было нечем
 * разложить: сменили промпт, ушли на другого провайдера или инструмент не
 * ответил — все три выглядели одинаково.
 *
 * Мешало этому одно место: `callAIWaterfall` объявлен как `Promise<string>` и
 * не сообщал вызывающему, кто ответил. Имя победителя известно в момент
 * вызова — его просто теряли.
 *
 * Сторож держит три свойства: имя победителя доходит наружу, реализация
 * водопада ОДНА (обёртка, а не копия), и незаписанное поле остаётся null, а
 * не подменяется догадкой.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintPrompt } from '@/lib/agents/managed/kuzmich-outcomes';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const PROVIDERS = read('lib/ai/providers.ts');
const CORE      = read('lib/kuzmich/core.ts');
const OUTCOMES  = read('lib/agents/managed/kuzmich-outcomes.ts');

/** Код без комментариев: судим употребление, а не рассказ о нём. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('отпечаток промпта', () => {
  it('одинаковый промпт — одинаковый отпечаток, разный — разный', () => {
    expect(fingerprintPrompt('а')).toBe(fingerprintPrompt('а'));
    expect(fingerprintPrompt('а')).not.toBe(fingerprintPrompt('б'));
  });

  it('это отпечаток, а не сам промпт: 8 hex и ничего больше', () => {
    // Промпт длинный и меняется целиком; в базе знаний он не нужен. Нужен
    // ответ на один вопрос — тот же он или уже другой.
    expect(fingerprintPrompt('какой-нибудь очень длинный системный промпт')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('водопад называет победителя', () => {
  it('реализация одна: callAIWaterfall — обёртка над подробной', () => {
    // Вторая копия водопада разошлась бы с первой ровно так же, как разошлись
    // две копии создания брони (08.09), и разница не была бы видна до дня,
    // когда она дорого стоит.
    const c = code(PROVIDERS);
    expect(c).toMatch(/export async function callAIWaterfall\(messages: ChatMessage\[\]\): Promise<string> \{\s*return \(await callAIWaterfallDetailed\(messages\)\)\.text;\s*\}/);
    expect(c).toMatch(/export async function callAIWaterfallDetailed/);
  });

  it('гонка помечена именами — иначе победитель безымянен', () => {
    const c = code(PROVIDERS);
    expect(c).toMatch(/raceProvidersLabelled/);
    for (const p of ['openrouter', 'deepseek', 'yandex', 'xai']) {
      expect(c, `${p} не помечен в гонке`).toMatch(new RegExp(`provider: '${p}'`));
    }
    // Непомеченная гонка осталась обёрткой, а не второй реализацией.
    expect(c).toMatch(/async function raceProviders\([\s\S]{0,200}raceProvidersLabelled/);
  });

  it('водопад инструментов тоже помечен, и его безымянная версия — обёртка', () => {
    const c = code(PROVIDERS);
    expect(c).toMatch(/firstNonNullToolLabelled/);
    expect(c).toMatch(/provider: 'deepseek',\s+run:/);
    expect(c).toMatch(/async function firstNonNullTool\([\s\S]{0,300}firstNonNullToolLabelled/);
  });

  it('не ответил никто — провайдер null, а не безымянный кто-то', () => {
    const c = code(PROVIDERS);
    expect(c).toMatch(/provider: null, tier: null, failed: true/);
  });

  it('эшелон записан: отвечал первый выбор или его пришлось заменять', () => {
    const c = code(PROVIDERS);
    expect(c).toMatch(/tier: 1, failed: false/);
    expect(c).toMatch(/tier: 2, failed: false/);
    expect(c).toMatch(/tier: 3, failed: false/);
  });

  it('модель не выдумывается из имени провайдера', () => {
    // Провайдерские вызовы модель не возвращают. Выводить её из провайдера —
    // записать догадку рядом с фактами; поля нет вовсе, пока нет источника.
    expect(code(PROVIDERS)).not.toMatch(/interface WaterfallOutcome[\s\S]{0,300}model/);
  });
});

describe('Кузьмич доносит происхождение до оценки', () => {
  it('запасной путь перебивает провайдера цикла инструментов', () => {
    // Ответ туристу произвёл ОН, а не тот, чью попытку отбросили.
    const c = code(CORE);
    expect(c).toMatch(/provenance\.path = 'waterfall'/);
    expect(c).toMatch(/provenance\.provider = fallback\.provider/);
  });

  it('в оценку уходят отпечаток, провайдер, путь и предложенные инструменты', () => {
    const c = code(CORE);
    expect(c).toMatch(/promptFingerprint: fingerprintPrompt\(KUZMICH_SYSTEM\)/);
    expect(c).toMatch(/provider: provenance\.provider/);
    expect(c).toMatch(/answerPath: provenance\.path/);
    expect(c).toMatch(/toolsOffered: KUZMICH_TOOLS\.map/);
  });

  it('оценка пишет это в metadata рядом с баллом, а не в другое место', () => {
    const c = code(OUTCOMES);
    expect(c).toMatch(/INSERT INTO agent_knowledge\([^)]*metadata/);
    expect(c).toMatch(/prompt_fingerprint:\s*opts\?\.promptFingerprint \?\? null/);
    expect(c).toMatch(/answer_path:\s*opts\?\.answerPath \?\? null/);
  });

  it('незаписанное поле — null, а не подставленное значение', () => {
    const c = code(OUTCOMES);
    // Каждое поле происхождения допускает отсутствие: запасной путь идёт без
    // инструментов, а при немоте всех провайдеров имени нет вовсе.
    for (const field of ['prompt_fingerprint', 'provider', 'answer_path', 'tools_offered', 'tools_ran']) {
      expect(c, `${field} не допускает «не записано»`).toMatch(new RegExp(`${field}:[^,]*\\?\\? null`));
    }
  });

  it('различает предложенные инструменты и сработавшие — это разные факты', () => {
    const c = code(OUTCOMES);
    expect(c).toMatch(/tools_offered/);
    expect(c).toMatch(/tools_ran/);
  });
});
