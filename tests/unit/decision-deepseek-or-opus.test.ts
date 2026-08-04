/**
 * Решатель эволюции — ТОЛЬКО DeepSeek или Opus (решение владельца 04.08).
 *
 * Почему это не косметика. Решатель порождает находки, которые уходят в GitHub
 * Issues и в работу. Хвост из моделей послабее опаснее их отсутствия: когда
 * сильные молчат, ответ всё равно приходил — но от слабой модели, и отличить
 * его было нечем, кроме поля `model`. Молчание честнее тихой подмены качества:
 * пустой ответ виден в алерте «решатель молчит», подменённый — нет.
 *
 * Отдельно фиксируем разбор ответа Anthropic. У моделей с расширенным
 * размышлением первым в `content` идёт блок thinking БЕЗ поля `text`, и прежняя
 * строка `content[0].text` давала undefined — решатель рапортовал «anthropic:
 * пустой ответ» при живом ключе и HTTP 200. Ровно это владелец и видел в отчёте.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

/** Тело решателя: от сигнатуры до закрывающей скобки функции. */
const decider = src.match(
  /export async function callAIDecisionDetailed[\s\S]*?\n\}/,
)?.[0] ?? '';

describe('решатель: только DeepSeek и Opus', () => {
  it('тело функции найдено — иначе сторож проверяет пустоту', () => {
    expect(decider.length).toBeGreaterThan(500);
  });

  it('DeepSeek в решателе есть', () => {
    expect(decider).toMatch(/api\.deepseek\.com/);
  });

  it('Anthropic (Opus) в решателе есть', () => {
    expect(decider).toMatch(/ANTHROPIC_BASE/);
    expect(decider).toMatch(/getAnthropicKey\(\)/);
  });

  it('Qwen из решателя убран', () => {
    expect(decider).not.toMatch(/getQwenConfig\(/);
    expect(decider).not.toMatch(/resolveDecisionModel\('qwen'\)/);
  });

  it('Kimi из решателя убран', () => {
    expect(decider).not.toMatch(/getMoonshotKey\(/);
    expect(decider).not.toMatch(/MOONSHOT_BASE/);
  });

  it('причина немоты по-прежнему фиксируется', () => {
    // Без этого «0 находок» неотличимо от здорового прогона.
    expect(decider).toMatch(/why\.push/);
    expect(decider).toMatch(/error: why\.join/);
  });
});

describe('ответ Anthropic разбирается правильно', () => {
  it('берётся первый ТЕКСТОВЫЙ блок, а не content[0]', () => {
    expect(decider).not.toMatch(/data\?\.content\?\.\[0\]\?\.text/);
    expect(decider).toMatch(/\.map\(b => \(typeof b\?\.text === 'string'/);
    expect(decider).toMatch(/\.filter\(Boolean\)/);
  });
});

describe('Qwen остаётся для других задач', () => {
  it('живой путь Кузьмича с инструментами не тронут', () => {
    // Qwen — первичный для чата Кузьмича: качество и достижимость из РФ.
    expect(src).toMatch(/export async function callQwenWithTools/);
    expect(src).toMatch(/export async function callQwen\b/);
  });
});
