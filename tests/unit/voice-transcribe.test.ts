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
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const providers = read('lib/ai/providers.ts');
const transcribe = providers.slice(
  providers.indexOf('// ── Распознавание речи'),
  providers.indexOf('// ── Gemini PDF Extraction'),
);

describe('распознавание речи: ступени', () => {
  // 20.11: судится вызовом, а не местом строк в исходнике. Адрес Gemini
  // переехал в lib/ai/gemini-endpoint.ts (шлюз Cloudflare, #3553), и прежняя
  // проверка по литералу адреса краснела при верном порядке ступеней.
  it('ступеней больше одной — нативный Gemini до OpenRouter', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'AIzaTEST-voice');
    vi.stubEnv('GEMINI_MODEL', 'gemini-test-flash');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-test-voice');
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response('{"error":"down"}', { status: 503 });
    }));
    try {
      const { callGeminiTranscribe } = await import('@/lib/ai/providers');
      const outcome = await callGeminiTranscribe('aGVsbG8=', 'audio/ogg');
      const native = urls.findIndex((u) => u.includes('/models/gemini-test-flash:generateContent'));
      const openrouter = urls.findIndex((u) => u.includes('/chat/completions'));
      expect(native, 'нативной ступени нет вовсе').toBeGreaterThan(-1);
      expect(openrouter, 'ступени OpenRouter нет вовсе').toBeGreaterThan(-1);
      expect(native, 'OpenRouter спрашивается раньше нативного пути').toBeLessThan(openrouter);
      // Обе ступени отказали — это «некому распознать», а не «плохо слышно».
      expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
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
    for (const file of ['app/api/max/kuzmich/route.ts']) {
      const src = read(file);
      expect(src, `${file}: исход отказа не различается`).toMatch(/voiceFailure === 'unintelligible'/);
      expect(src, `${file}: про недоступность распознавания человеку не сказано`)
        .toMatch(/Распознавание речи сейчас недоступно/);
      expect(src, `${file}: старое поведение — одна фраза на оба исхода`)
        .not.toMatch(/transcription = await callGeminiTranscribe/);
    }
  });
});
