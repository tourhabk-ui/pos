/**
 * Судья фактгейта ходит качественным путём, а не гонкой.
 *
 * Разведчик молчал 22 дня, и предупреждение звало чинить провайдера. Перепись
 * прогонов на проде (30 записей, 23.08) показала другое: сигналы собирались
 * исправно — от 25 до 53 за прогон, — синтез выпуска проходил, а вставал
 * ГЕЙТ ПУБЛИКАЦИИ. Шесть прогонов подряд с 18 по 22.08 отказывали кодом
 * `judge_unparseable`: «ответила прозой вместо JSON».
 *
 * Причина оказалась в устройстве, а не в ключах. Сам выпуск синтезировался
 * через `callAIQuality` — детерминированный порядок DeepSeek, затем Qwen.
 * Судья же единственный звался через `callAIFast` — ГОНКУ дешёвых провайдеров,
 * где побеждает самый быстрый. Формат JSON у провайдера просили, но гарантия
 * есть лишь у тех, кто `response_format` поддерживает; выигрывал гонку не
 * обязательно такой. Ровно то, о чём предупреждает шапка `providers.ts`:
 * «гонку выигрывала самая быстрая мелкая модель, и публичные тексты писала
 * она».
 *
 * Гейт публикации — не место для гонки. Здесь важна не скорость ответа, а то,
 * что ответ вообще разберут.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf-8');
}

const FACTCHECK = read('lib/agents/fact-check.ts');
const CODE = FACTCHECK.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const PROVIDERS = read('lib/ai/providers.ts');

describe('судья не участвует в гонке', () => {
  it('быстрая ветка в фактчеке не вызывается', () => {
    expect(CODE).not.toMatch(/callAIFast/);
  });

  it('судья зовёт качественный путь', () => {
    expect(CODE).toMatch(/callAIQualityOrNull\(messages/);
  });

  it('импорт тоже переведён, а не оставлен мёртвым', () => {
    expect(CODE).toMatch(/import \{ callAIQualityOrNull \} from '@\/lib\/ai\/providers'/);
  });
});

describe('формат просят у провайдера, а не уговаривают промптом', () => {
  it('судья просит json', () => {
    const call = CODE.slice(CODE.indexOf('callAIQualityOrNull(messages'));
    expect(call.slice(0, 300)).toMatch(/json: true/);
  });

  it('качественный путь умеет передавать response_format', () => {
    const q = PROVIDERS.slice(
      PROVIDERS.indexOf('export async function callAIQuality('),
      PROVIDERS.indexOf('export async function callAIQualityOrNull('),
    );
    expect(q).toMatch(/response_format: \{ type: 'json_object' \}/);
    // Обе ноги — DeepSeek и Qwen — а не только первая: иначе при отказе
    // DeepSeek гарантия формата тихо пропадала бы.
    expect((q.match(/\.\.\.format/g) ?? []).length).toBe(2);
  });

  it('обёртка с null пропускает json дальше', () => {
    const wrap = PROVIDERS.slice(PROVIDERS.indexOf('export async function callAIQualityOrNull('));
    expect(wrap.slice(0, 300)).toMatch(/json\?: boolean/);
  });

  it('судья буквален: температура ноль', () => {
    // Он цитирует утверждения дословно — выдумывать формулировки ему нечего.
    const call = CODE.slice(CODE.indexOf('callAIQualityOrNull(messages'));
    expect(call.slice(0, 400)).toMatch(/temperature: 0/);
  });
});

describe('разбор и повтор остались страховкой', () => {
  it('«оборвано» и «проза» по-прежнему различаются', () => {
    // Лечатся в разных местах: одно потолком токенов, другое промптом.
    expect(CODE).toMatch(/'truncated'/);
    expect(CODE).toMatch(/'unparseable'/);
  });

  it('отказ провайдера остаётся отдельной причиной', () => {
    expect(CODE).toMatch(/why: 'unavailable'/);
  });

  it('повтор идёт только на бедах разбора', () => {
    expect(CODE).toMatch(/fixableByAsking/);
  });
});

describe('мёртвых настроек не осталось', () => {
  it('константа предела ожидания убрана вместе с быстрой веткой', () => {
    // У качественного пути свои 45 секунд — ровно та же величина. Число,
    // которое ничем не управляет, врёт об этом самим своим присутствием.
    expect(CODE).not.toMatch(/JUDGE_TIMEOUT_MS/);
  });
});
