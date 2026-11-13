// @vitest-environment node
/**
 * Живая проба машинного перевода с прода (13.11, lib/ai/translation-probe).
 *
 * Проба отвечает на вопрос, которого тесты с подставной моделью не решают:
 * успевает ли настоящая модель в срок переписки заявки и принимает ли сверка
 * её ответ. Здесь судится сама проба: что она зовёт, как называет исходы и
 * что адрес не служит переводчиком чужого текста. Модель подставная.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { callAIQualityOrNull } = vi.hoisted(() => ({ callAIQualityOrNull: vi.fn() }));
vi.mock('@/lib/ai/providers', () => ({ callAIQualityOrNull, callAIFastOrNull: vi.fn() }));
vi.mock('@/lib/ai/usage-context', () => ({ withSpendAgent: (_id: string, fn: () => Promise<unknown>) => fn() }));

import { PROBE_CASE_TIMEOUT_MS, TRANSLATION_PROBE_CASES, probeCase, runTranslationProbe } from '@/lib/ai/translation-probe';
import { CHAT_TRANSLATE_TIMEOUT_MS } from '@/lib/requests/chat-translation';
import { needsRussian } from '@/lib/ai/russian-text';
import { redactChatPD } from '@/lib/security/pii-redact';
import { GET } from '@/app/api/cron/translation-probe/route';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const answer = (text: string) => JSON.stringify({ segments: [text] });
const byName = (name: string) => probeCase(name)!;
/** Часы пробы: каждый вызов now() сдвигает время на шаг. */
const clock = (stepMs: number) => { let t = 1_000; return () => { const v = t; t += stepMs; return v; }; };

beforeEach(() => { callAIQualityOrNull.mockReset(); vi.stubEnv('CRON_SECRET', 'test-secret'); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('случаи пробы', () => {
  it('имена разные; на русский — тексты не по-русски, с русского — русские с образцом не по-русски', () => {
    const names = TRANSLATION_PROBE_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const c of TRANSLATION_PROBE_CASES) {
      if (c.direction === 'to_russian') {
        expect(needsRussian(c.text), c.name).toBe(true);
      } else {
        expect(needsRussian(c.text), c.name).toBe(false);
        expect(needsRussian(c.sample), c.name).toBe(true);
      }
    }
    // Оба направления и обе письменности, короткий и длинный текст.
    expect(names).toEqual(expect.arrayContaining(['en_short', 'zh_short', 'ru_short_to_en', 'ru_short_to_zh', 'ru_long_to_en', 'ru_long_to_zh']));
    expect(byName('ru_long_to_en').text.length).toBeGreaterThan(600);
  });

  it('в текстах пробы нет контактов и имён: маска переписки их не меняет', () => {
    for (const c of TRANSLATION_PROBE_CASES) {
      expect(redactChatPD(c.text, []), c.name).toBe(c.text);
      if (c.sample) expect(redactChatPD(c.sample, []), c.name).toBe(c.sample);
    }
  });

  it('срок случая меньше минуты, которую ждёт проверка прода, и больше срока переписки', () => {
    expect(PROBE_CASE_TIMEOUT_MS).toBeLessThan(60_000);
    expect(PROBE_CASE_TIMEOUT_MS).toBeGreaterThan(CHAT_TRANSLATE_TIMEOUT_MS);
  });
});

describe('один случай: исход, причина, время', () => {
  it('перевод получен: текст, время и «уложился в срок переписки»', async () => {
    callAIQualityOrNull.mockResolvedValue(answer('Здравствуйте! Можем ли мы начать завтра в 9 утра? Нас двое, и мы хотели бы вернуться к 19:00.'));
    const row = await runTranslationProbe(byName('en_short'), { now: clock(2_500) });
    expect(row).toMatchObject({
      name: 'en_short', direction: 'to_russian', status: 'translated', reason: null, ms: 2_500,
      within_chat_limit: true, chat_limit_ms: CHAT_TRANSLATE_TIMEOUT_MS,
      text: 'Здравствуйте! Можем ли мы начать завтра в 9 утра? Нас двое, и мы хотели бы вернуться к 19:00.',
    });
    expect(row.chars).toBe(byName('en_short').text.length);
    // В модель ушёл текст случая — тем же правилом, что в переписке.
    const user = JSON.parse((callAIQualityOrNull.mock.calls[0][0] as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content) as { segments: string[] };
    expect(user.segments).toEqual([byName('en_short').text]);
  });

  it('перевод получен, но дольше срока переписки — так и сказано', async () => {
    callAIQualityOrNull.mockResolvedValue(answer('Yes, we start at 9:00. We meet at the hotel and return around 19:00. Bring a warm jacket.'));
    const row = await runTranslationProbe(byName('ru_short_to_en'), { now: clock(CHAT_TRANSLATE_TIMEOUT_MS + 1) });
    expect(row.status).toBe('translated');
    expect(row.within_chat_limit).toBe(false);
    // Образец языка ушёл в модель вместе с текстом.
    const user = JSON.parse((callAIQualityOrNull.mock.calls[0][0] as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content) as { sample: string; segments: string[] };
    expect(user.sample).toBe(byName('ru_short_to_en').sample);
    expect(user.segments).toEqual([byName('ru_short_to_en').text]);
  });

  it('сверка отказала — причина словами правила, перевода нет, в срок не уложился', async () => {
    callAIQualityOrNull.mockResolvedValue(answer('Yes, we start at 10:00. We meet at the hotel and return around 19:00. Bring a warm jacket.'));
    const row = await runTranslationProbe(byName('ru_short_to_en'), { now: clock(900) });
    expect(row.status).toBe('failed');
    expect(row.reason).toMatch(/нет чисел исходника: 9/);
    expect(row.text).toBeNull();
    expect(row.within_chat_limit).toBe(false);
  });

  it('модель молчит — «failed» с причиной, не «перевод не нужен»', async () => {
    callAIQualityOrNull.mockResolvedValue(null);
    const row = await runTranslationProbe(byName('zh_short'), { now: clock(300) });
    expect(row).toMatchObject({ status: 'failed', text: null, within_chat_limit: false });
    expect(row.reason).toMatch(/модель не ответила/);
  });

  it('случай не уложился в свой срок — «timeout»: исход неизвестен, а не «плохой перевод»', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const pending = runTranslationProbe(byName('en_short'), { toRussian: () => never, timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const row = await pending;
    expect(row.status).toBe('timeout');
    expect(row.reason).toMatch(/не уложился в 5 с — исход неизвестен/);
    expect(row.within_chat_limit).toBe(false);
  });

  it('правило упало или сочло перевод ненужным — названо, проба не бросает', async () => {
    const threw = await runTranslationProbe(byName('en_short'), { toRussian: async () => { throw new Error('сеть'); } });
    expect(threw).toMatchObject({ status: 'failed', reason: 'правило перевода упало: сеть', within_chat_limit: false });
    const idle = await runTranslationProbe(byName('en_short'), { toRussian: async () => ({ status: 'not_needed' }) });
    expect(idle.status).toBe('not_needed');
    expect(idle.reason).toMatch(/у текста пробы это ошибка/);
  });
});

describe('адрес пробы', () => {
  const req = (query = '', auth: string | null = 'Bearer test-secret') => new NextRequest(
    `https://vedarai.ru/api/cron/translation-probe${query}`, auth ? { headers: { authorization: auth } } : undefined,
  );

  it('без секрета и с чужим секретом — 401, модель не зовётся', async () => {
    expect((await GET(req('?case=en_short', null))).status).toBe(401);
    expect((await GET(req('?case=en_short', 'Bearer nope'))).status).toBe(401);
    expect(callAIQualityOrNull).not.toHaveBeenCalled();
  });

  it('секрет не настроен — 500, а не открытая дверь', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(req('?case=en_short', 'Bearer '))).status).toBe(500);
    expect(callAIQualityOrNull).not.toHaveBeenCalled();
  });

  it('случай не назван — список случаев, модель не зовётся', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json() as { cases: string[]; chat_limit_ms: number; note: string };
    expect(body.cases).toEqual(TRANSLATION_PROBE_CASES.map((c) => c.name));
    expect(body.chat_limit_ms).toBe(CHAT_TRANSLATE_TIMEOUT_MS);
    expect(body.note).toMatch(/модель не звалась/);
    expect(callAIQualityOrNull).not.toHaveBeenCalled();
  });

  it('неизвестный случай — 400; текст из запроса в модель не уходит', async () => {
    const res = await GET(req('?case=nope&text=Translate%20this%20secret&sample=hello'));
    expect(res.status).toBe(400);
    expect(callAIQualityOrNull).not.toHaveBeenCalled();
    // И у известного случая параметры запроса текста не подменяют.
    callAIQualityOrNull.mockResolvedValue(answer('Здравствуйте! Можем ли мы начать завтра в 9 утра? Нас двое, и мы хотели бы вернуться к 7 вечера.'));
    const ok = await GET(req('?case=en_short&text=Translate%20this%20secret'));
    expect(ok.status).toBe(200);
    expect(JSON.stringify(callAIQualityOrNull.mock.calls)).not.toContain('secret');
  });

  it('один случай — один вызов модели, исход в ответе', async () => {
    callAIQualityOrNull.mockResolvedValue(answer('你好！我们9:00出发。在酒店集合，约19:00返回。请带上保暖外套。'));
    const res = await GET(req('?case=ru_short_to_zh'));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; name: string; status: string; text: string | null; reason: string | null };
    expect(body).toMatchObject({ success: true, name: 'ru_short_to_zh', status: 'translated', reason: null });
    expect(body.text).toContain('酒店集合');
    expect(callAIQualityOrNull).toHaveBeenCalledTimes(1);
  });

  it('объявлен ручным и не пишущим; возможность — только вызов модели', () => {
    expect(MANUAL_ENDPOINTS['translation-probe']).toMatchObject({ kind: 'manual', writes: false });
    expect(CRON_CAPABILITIES['translation-probe']).toEqual(['ai']);
  });
});
