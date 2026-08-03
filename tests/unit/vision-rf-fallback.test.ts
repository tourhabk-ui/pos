/**
 * Зрение Кузьмича должно работать из РФ. Веб-чат отвечал «фото не вижу», потому
 * что callGeminiVision ходил только в Gemini (нативный + через OpenRouter) —
 * оба гео-блокируются из РФ (Timeweb). Добавлен RF-достижимый Qwen-VL (DashScope,
 * тот же провайдер, что текстовый Qwen). Сторож фиксирует наличие фолбэка.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');
const fn = src.slice(
  src.indexOf('export async function callGeminiVision'),
  src.indexOf('// ── Gemini Audio Transcription'),
);

describe('зрение Кузьмича — RF-фолбэк', () => {
  it('есть Qwen-VL фолбэк на DashScope', () => {
    expect(fn).toContain('getQwenConfig()');
    expect(fn).toMatch(/qwen-vl-max/);
    expect(fn).toContain('QWEN_VISION_MODEL');
  });
  it('Qwen-VL достижим даже без ключа OpenRouter (не ранний return null)', () => {
    // Прежде было `if (!apiKey) return null;` — Qwen никогда не пробовался.
    expect(fn).not.toMatch(/const apiKey = getOpenRouterKey\(\);\s*\n\s*if \(!apiKey\) return null;/);
    expect(fn).toContain('if (apiKey) {');
  });
  it('шлёт изображение как data-URL в content', () => {
    expect(fn).toMatch(/image_url: \{ url: `data:\$\{mimeType\};base64,\$\{imageBase64\}` \}/);
  });
});
