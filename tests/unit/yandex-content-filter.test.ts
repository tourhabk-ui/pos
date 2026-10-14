/**
 * Отказ фильтра Яндекса — «не смог», а не ответ (14.10).
 *
 * Проба знания, прогон 5: ключ и каталог на Timeweb исправлены, YandexGPT
 * ответил за 0,6 с — заготовкой «Я не могу обсуждать эту тему. Давайте
 * поговорим о чём-нибудь ещё.» со статусом ALTERNATIVE_STATUS_CONTENT_FILTER.
 * Обёртка отдала её как текст, и проба записала «не знает» (§4.0: отказ — не
 * «не знаю»). Хуже другое: во втором эшелоне водопада гонку выигрывает любой
 * непустой текст, а YandexGPT там самый быстрый, — заготовка ушла бы туристу
 * ответом Кузьмича.
 *
 * Сторож — вызов обёртки и водопада на ответе Яндекса той формы, что пришла
 * с прода.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callYandexGPT, callAIWaterfallDetailed } from '@/lib/ai/providers';
import { recentAiFailures } from '@/lib/ai/failure-trace';

const REFUSAL = 'Я не могу обсуждать эту тему. Давайте поговорим о чём-нибудь ещё.';
const YANDEX_HOST = 'llm.api.cloud.yandex.net';

function yandexReply(status: string, text: string): Response {
  return new Response(JSON.stringify({
    result: {
      alternatives: [{ message: { role: 'assistant', text }, status }],
      usage: { inputTextTokens: '40', completionTokens: '15', totalTokens: '55' },
      modelVersion: 'test',
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Яндекс отвечает заданным, любой другой провайдер — отказом сервера. */
function stubFetch(status: string, text: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.includes(YANDEX_HOST) ? yandexReply(status, text) : new Response('unavailable', { status: 503 });
  }));
}

beforeEach(() => {
  vi.stubEnv('YANDEX_API_KEY', 'test-key');
  vi.stubEnv('YANDEX_FOLDER_ID', 'b1gtestfolder0000000');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('YandexGPT: отказ фильтра', () => {
  it('заготовка фильтра не выходит наружу текстом, причина — в следе', async () => {
    stubFetch('ALTERNATIVE_STATUS_CONTENT_FILTER', REFUSAL);
    const started = Date.now();
    expect(await callYandexGPT([{ role: 'user', content: 'Что такое сайт vedarai.ru?' }])).toBeNull();
    const trace = recentAiFailures(60_000).filter((f) => f.provider === 'yandex' && f.at >= started);
    expect(trace.at(-1)?.reason).toMatch(/^content_filter/);
  });

  it('обычный ответ проходит как был', async () => {
    stubFetch('ALTERNATIVE_STATUS_FINAL', ' Камчатка — полуостров на востоке России. ');
    expect(await callYandexGPT([{ role: 'user', content: 'Где Камчатка?' }]))
      .toBe('Камчатка — полуостров на востоке России.');
  });

  it('ответ, обрезанный по лимиту токенов, — тоже ответ, а не отказ', async () => {
    stubFetch('ALTERNATIVE_STATUS_TRUNCATED_FINAL', 'Длинный ответ про вулканы');
    expect(await callYandexGPT([{ role: 'user', content: 'Расскажи подробно' }])).toBe('Длинный ответ про вулканы');
  });
});

describe('водопад: заготовка фильтра не становится ответом туристу', () => {
  it('единственный живой — YandexGPT с отказом фильтра: водопад честно не ответил', async () => {
    stubFetch('ALTERNATIVE_STATUS_CONTENT_FILTER', REFUSAL);
    const out = await callAIWaterfallDetailed([{ role: 'user', content: 'Безопасно ли сейчас на Авачинском?' }]);
    expect(out.text).not.toContain('не могу обсуждать');
    expect(out.provider).toBeNull();
    expect(out.failed).toBe(true);
  }, 20_000);

  it('тот же YandexGPT с обычным ответом водопад вытягивает вторым эшелоном', async () => {
    stubFetch('ALTERNATIVE_STATUS_FINAL', 'Обстановку смотрите в сводке МЧС.');
    const out = await callAIWaterfallDetailed([{ role: 'user', content: 'Безопасно ли сейчас на Авачинском?' }]);
    expect(out).toMatchObject({ provider: 'yandex', tier: 2, failed: false });
  }, 20_000);
});
