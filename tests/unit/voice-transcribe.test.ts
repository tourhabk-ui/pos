/**
 * Сторож: распознавание речи не выдаёт «не смог» за «плохо слышно».
 *
 * До 08.09 путь был один — Gemini через OpenRouter, а OpenRouter с прода
 * отвечает 403 и напрямую, и через релей (замер 07.09: ответы совпали
 * дословно). То есть на проде не расшифровывалось ни одно голосовое, а
 * человек в поле получал «Не разобрал голосовое» — фразу про свою дикцию
 * вместо правды о том, что распознавать было некому. Повторять её
 * бессмысленно, и человек повторял.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const providers = read('lib/ai/providers.ts');
const transcribe = providers.slice(
  providers.indexOf('// ── Распознавание речи'),
  providers.indexOf('// ── Gemini PDF Extraction'),
);

describe('распознавание речи: ступени', () => {
  it('ступеней больше одной — нативный Gemini до OpenRouter', () => {
    const native = transcribe.indexOf('generativelanguage.googleapis.com');
    const openrouter = transcribe.indexOf('OPENROUTER_BASE');
    expect(native, 'нативной ступени нет вовсе').toBeGreaterThan(-1);
    expect(openrouter, 'ступени OpenRouter нет вовсе').toBeGreaterThan(-1);
    expect(native, 'OpenRouter спрашивается раньше нативного пути').toBeLessThan(openrouter);
  });

  it('модель не прибита к id — резолв, как у зрения', () => {
    // Хардкод gemini-2.0-flash отвечал 404 «no longer available» (04.09).
    expect(transcribe).toMatch(/resolveGeminiModel\(\)/);
  });

  it('отказ каждой ступени назван и попадает в след', () => {
    // Голый `catch { return null }` делал поломку неотличимой от тишины.
    expect(transcribe).toMatch(/recordAiLegFailure\(`transcribe:/);
    expect(transcribe).not.toMatch(/catch\s*\{\s*return null;?\s*\}/);
  });
});

describe('распознавание речи: два разных отказа', () => {
  it('тип различает «не разобрал» и «некому слушать»', () => {
    expect(transcribe).toMatch(/reason: 'unintelligible'/);
    expect(transcribe).toMatch(/reason: 'unavailable'/);
  });

  it('оба канала говорят человеку разные фразы', () => {
    for (const file of ['app/api/telegram/kuzmich/route.ts', 'app/api/max/kuzmich/route.ts']) {
      const src = read(file);
      expect(src, `${file}: исход отказа не различается`).toMatch(/voiceFailure === 'unintelligible'/);
      expect(src, `${file}: про недоступность распознавания человеку не сказано`)
        .toMatch(/Распознавание речи сейчас недоступно/);
      expect(src, `${file}: старое поведение — одна фраза на оба исхода`)
        .not.toMatch(/transcription = await callGeminiTranscribe/);
    }
  });
});
