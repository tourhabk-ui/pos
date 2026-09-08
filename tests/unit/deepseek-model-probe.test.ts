/**
 * tests/unit/deepseek-model-probe.test.ts
 *
 * Замер отвечает цифрой или молчит — но не выдаёт анонс за измерение.
 *
 * ── Зачем проба (08.09) ────────────────────────────────────────────────────
 *
 * В этот день DeepSeek стал ПЕРВИЧНЫМ в водопаде инструментов Кузьмича — на
 * месте снятого Qwen. И в этот же день пришла новость о внутреннем
 * тестировании `deepseek-v4.1-flash-expires-on-0910`: та же цена, около 400
 * tok/s. То есть речь о скорости ровно там, где ответа ждёт человек в поле,
 * иногда на плохой связи.
 *
 * Анонсные 400 tok/s измерены не у нас, не с нашего прода и не на наших
 * промптах. Переключить живой путь по чужой цифре — это заполнить пустое
 * место догадкой, а не знанием (§4.0).
 *
 * ── Что сторожится ─────────────────────────────────────────────────────────
 *
 * Не «работает ли HTTP», а честность выводов: деление, которое не из чего
 * сделать, обязано давать null, а не ноль; разница внутри шума обязана
 * называться шумом; молчащая база сравнения обязана давать «вывода нет», а не
 * победу кандидата.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tokensPerSec,
  compareVerdict,
  bestOf,
  MODEL_ID_RE,
  type ModelMeasurement,
} from '@/app/api/cron/deepseek-model-probe/route';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/deepseek-model-probe/route.ts'), 'utf-8');

function m(over: Partial<ModelMeasurement>): ModelMeasurement {
  return {
    model: 'x', outcome: 'ok', http_status: 200, latency_ms: 1000,
    completion_tokens: 100, tokens_per_sec: 100, answer_preview: 'ответ', detail: null,
    ...over,
  };
}

describe('скорость выдачи: цифра или null, но не ноль и не бесконечность', () => {
  it('считается по полной задержке — столько и ждёт человек', () => {
    expect(tokensPerSec(200, 500)).toBe(400);
  });

  it('токенов провайдер не назвал — считать не из чего', () => {
    expect(tokensPerSec(null, 500)).toBeNull();
  });

  it('ноль токенов — не «ноль в секунду», а нечего мерить', () => {
    // Ноль выглядит как измерение и читается как «модель очень медленная».
    expect(tokensPerSec(0, 500)).toBeNull();
  });

  it('нулевая задержка не превращается в бесконечность', () => {
    expect(tokensPerSec(100, 0)).toBeNull();
  });
});

describe('вердикт не выдаёт желаемое за измеренное', () => {
  it('кандидат не ответил — переключать нечего, что бы ни обещал анонс', () => {
    const v = compareVerdict(m({ model: 'cand', outcome: 'refused' }), m({ model: 'base' }));
    expect(v).toMatch(/не ответил/);
    expect(v).toMatch(/переключать нечего/);
  });

  it('база молчит — «вывода НЕТ», а не победа кандидата', () => {
    // Самая соблазнительная подмена: кандидат ответил за 300 мс, база не
    // ответила вовсе — и хочется написать «кандидат быстрее». Не с чем.
    const v = compareVerdict(m({ model: 'cand', latency_ms: 300 }), m({ model: 'base', outcome: 'unreachable' }));
    expect(v).toMatch(/вывода о выигрыше НЕТ/);
  });

  it('базы нет вовсе — тот же ответ', () => {
    expect(compareVerdict(m({}), null)).toMatch(/вывода о выигрыше НЕТ/);
  });

  it('кандидата не задавали — сравнивать нечего', () => {
    expect(compareVerdict(null, m({}))).toMatch(/сравнивать нечего/);
  });

  it('разница меньше 15% названа шумом, а не выигрышем', () => {
    const v = compareVerdict(m({ model: 'cand', latency_ms: 920 }), m({ model: 'base', latency_ms: 1000 }));
    expect(v).toMatch(/в пределах шума/);
    expect(v).not.toMatch(/быстрее/);
  });

  it('настоящий выигрыш назван с цифрами обеих сторон', () => {
    const v = compareVerdict(m({ model: 'cand', latency_ms: 400 }), m({ model: 'base', latency_ms: 1000 }));
    expect(v).toMatch(/быстрее/);
    expect(v).toMatch(/400 мс/);
    expect(v).toMatch(/1000 мс/);
  });

  it('проигрыш называется вслух, а не замалчивается', () => {
    const v = compareVerdict(m({ model: 'cand', latency_ms: 2000 }), m({ model: 'base', latency_ms: 1000 }));
    expect(v).toMatch(/МЕДЛЕННЕЕ/);
  });
});

describe('лучший из серии', () => {
  it('берётся самый быстрый успешный, а не первый', () => {
    const best = bestOf([m({ latency_ms: 900 }), m({ latency_ms: 400 }), m({ latency_ms: 700 })]);
    expect(best?.latency_ms).toBe(400);
  });

  it('успешных нет — отдаётся отказ, а не выдуманный успех', () => {
    const best = bestOf([m({ outcome: 'refused', http_status: 404 }), m({ outcome: 'refused', http_status: 404 })]);
    expect(best?.outcome).toBe('refused');
  });

  it('замеров нет — null', () => {
    expect(bestOf([])).toBeNull();
  });
});

describe('имя модели проверяется по форме', () => {
  it('настоящий id кандидата проходит — там есть и точка, и дефисы', () => {
    expect(MODEL_ID_RE.test('deepseek-v4.1-flash-expires-on-0910')).toBe(true);
  });

  it('слэш и двоеточие не проходят — путь и схема тут не нужны', () => {
    expect(MODEL_ID_RE.test('deepseek/chat')).toBe(false);
    expect(MODEL_ID_RE.test('http://evil')).toBe(false);
  });

  it('пустое имя не проходит', () => {
    expect(MODEL_ID_RE.test('')).toBe(false);
  });
});

describe('границы самого роута', () => {
  it('адрес провайдера — литерал, из запроса приходит только имя модели', () => {
    // SSRF: если бы хост собирался из параметра, роут с секретом прода стал бы
    // прокси на что угодно (тот же довод, что у source-probe).
    expect(SRC).toMatch(/const DEEPSEEK_CHAT = 'https:\/\/api\.deepseek\.com\/v1\/chat\/completions'/);
    expect(SRC).not.toMatch(/searchParams\.get\('(url|base|host|endpoint)'\)/);
  });

  it('id базы сравнения не прибит — берётся из каталога провайдера (§8)', () => {
    expect(SRC).toMatch(/const baselineId = ids\.find/);
  });

  it('нет ключа — «спросить нечем», а не «моделей нет»', () => {
    expect(SRC).toMatch(/DEEPSEEK_API_KEY не задан — замерить нечем/);
  });

  it('HTTP 200 с пустым телом не считается успехом', () => {
    expect(SRC).toMatch(/outcome: 'empty'/);
  });

  it('отказ провайдера и сетевой отказ — разные исходы', () => {
    expect(SRC).toMatch(/outcome: 'refused'/);
    expect(SRC).toMatch(/outcome: 'unreachable'/);
  });

  it('отклонённое по форме имя названо, а не проглочено', () => {
    // Иначе опечатка в id выглядит как «кандидат не задан».
    expect(SRC).toMatch(/candidate_rejected/);
  });
});
