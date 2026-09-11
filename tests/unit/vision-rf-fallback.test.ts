/**
 * Зрение Кузьмича должно работать из РФ — и должно уметь сказать, почему не
 * сработало.
 *
 * ── Первая половина сторожа (старая, в силе) ──────────────────────────────
 *
 * Веб-чат отвечал «фото не вижу», потому что путь зрения ходил только в Gemini
 * (нативный и через OpenRouter) — оба гео-блокируются из РФ (Timeweb). Тогда
 * добавили RF-достижимый Qwen-VL на DashScope. Сторож держит наличие фолбэка,
 * чтобы его не сняли заодно с чем-нибудь.
 *
 * ── Вторая половина (11.09) ───────────────────────────────────────────────
 *
 * Отказ КАЖДОЙ ступени ловился пустым `catch {}`. Наружу выходило одно
 * состояние — `null`, «фото не вижу», — под которым пряталось четыре разных:
 * ключа нет, провайдер отверг (401/403/квота), сеть не дошла, ответ пуст.
 * Различить их было нечем ни человеку в поле, ни админу на /hub/admin/health:
 * «мы не настроены» и «провайдер нас отверг» выглядели одинаково (§4.0 —
 * отказ не глушится).
 *
 * Поэтому здесь же держится: пустых catch в блоке зрения нет, у ступени
 * четыре исхода, а `skipped` не притворяется отказом провайдера.
 *
 * ── Про имя ───────────────────────────────────────────────────────────────
 *
 * Функция звалась `callGeminiVision`, а на проде фото разбирал Qwen: имя
 * обещало путь, которого с прода нет (правило 10.09). Переименована в
 * `callVision`; сторож не даёт старому имени вернуться.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');
const fn = src.slice(
  src.indexOf('export async function callVisionDetailed'),
  src.indexOf('// ── Распознавание речи'),
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
  });
  it('шлёт изображение как data-URL в content', () => {
    expect(src).toMatch(/image_url: \{ url: `data:\$\{mimeType\};base64,\$\{imageBase64\}` \}/);
  });
});

describe('зрение — отказ называется, а не глушится (§4.0)', () => {
  it('в блоке зрения нет пустых catch', () => {
    // Именно они и превращали четыре разных поломки в одно «фото не вижу».
    expect(fn, 'вернулся пустой catch — причина отказа снова теряется')
      .not.toMatch(/catch\s*\{\s*\/\*[^*]*\*\/\s*\}/);
    expect(fn).not.toMatch(/catch\s*\{\s*\}/);
  });

  it('у ступени четыре исхода, и «не настроено» отделено от «отвергли»', () => {
    for (const outcome of ["'ok'", "'refused'", "'unreachable'", "'empty'", "'skipped'"]) {
      expect(src, `исход ${outcome} исчез из типа`).toContain(outcome);
    }
    // Нет ключа — это `skipped` с названной переменной, а не отказ провайдера.
    expect(fn).toMatch(/'skipped', 'GEMINI_API_KEY не задан'/);
    expect(fn).toMatch(/'skipped', 'OPENROUTER_API_KEY не задан'/);
  });

  it('каждая ступень пишет причину в общий след отказов', () => {
    expect(fn).toContain('recordAiLegFailure(`vision_${provider}`');
  });
});

describe('ступень DeepSeek заведена, но не выдумана', () => {
  it('модель не хардкодится — без имени ступень пропускается с причиной', () => {
    expect(fn).toContain('DEEPSEEK_VISION_MODEL');
    expect(fn, 'ступень пробует наугад вместо честного пропуска').toMatch(
      /'skipped', 'модель со зрением не названа/,
    );
    // Хардкод id модели DeepSeek в боевом коде запрещён (§8): сильнейшую
    // берут из каталога, а «зрение» каталогом не помечено никак.
    expect(fn).not.toMatch(/deepseek-(v4|flash|chat)[A-Za-z0-9.-]*'/);
  });

  it('имя модели из запроса проверяется по форме', () => {
    expect(src).toContain('VISION_MODEL_ID_RE');
    expect(fn).toContain('VISION_MODEL_ID_RE.test(model)');
  });
});

describe('имя функции не обещает недостижимую ступень (правило 10.09)', () => {
  it('старое имя callGeminiVision не вернулось', () => {
    expect(src, 'имя обещает Gemini, а с прода работает не он')
      .not.toContain('export async function callGeminiVision');
  });
});
