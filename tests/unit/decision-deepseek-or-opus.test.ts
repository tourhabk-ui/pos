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
    // Именно toContain, а не регулярка: шаблон с хостом без якорей CodeQL
    // справедливо считает опасной формой (годится для обхода проверки URL).
    // Здесь нужна простая проверка подстроки — регулярка тут ничего не даёт.
    expect(decider).toContain('api.deepseek.com');
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

describe('Qwen снят с текстовых путей, но ключ ещё держит зрение', () => {
  it('tools-цикл Кузьмича через Qwen больше не идёт', () => {
    // До 08.09 Qwen был ПЕРВИЧНЫМ в водопаде инструментов — «качество и
    // достижимость из РФ». Достижимость кончилась: ключ DashScope отвергнут в
    // обоих регионах, и ступени водопада идут последовательно, то есть каждое
    // сообщение человека в поле сначала ждало заведомого отказа. Снято
    // решением владельца («qwen не используем»), функция удалена.
    expect(src).not.toMatch(/callQwenWithTools/);
  });

  it('одиночный callQwen жив: на нём стоит проба ключа, от которого зависит зрение', () => {
    // qwen-vl — единственное достижимое с прода зрение (Gemini гео-блокируется,
    // Anthropic без баланса). Убрать пробу значило бы перестать замечать, что
    // Кузьмич не видит присланное фото.
    expect(src).toMatch(/export async function callQwen\b/);
  });
});
