/**
 * Речь Кузьмича (#1992): кнопка «Озвучить» → POST /api/ai/speak → DashScope.
 *
 * Что держит сторож:
 * 1. Модель — из каталога ключа, не из кода (§8); выбирается основная, а не
 *    realtime/клон/дизайн/датированный снимок.
 * 2. Три исхода синтеза, не два: ok только с байтами аудио; отказ провайдера и
 *    «не дошли» различимы и не выдаются за голос (§4.0).
 * 3. Чат открыт анонимам — у озвучки два предохранителя: частота по IP и
 *    дневной потолок; упёрлись — 429 со словами, а не тишина.
 * 4. Обрезанный текст признаётся: заголовок и фраза в кнопке.
 * 5. Расход уходит в книги; не ушёл — это сказано в лог.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const { getQwenConfig, logSpeechUsage } = vi.hoisted(() => ({
  getQwenConfig: vi.fn(),
  logSpeechUsage: vi.fn(),
}));
vi.mock('@/lib/ai/providers', () => ({ getQwenConfig, logSpeechUsage }));

import {
  pickSpeechModel, prepareSpeechText, synthesizeSpeech, resetSpeechCatalogCache, SPEECH_MAX_CHARS,
} from '@/lib/ai/tts';
import { POST, resetSpeakDailyCounter, DEFAULT_DAILY_MAX } from '@/app/api/ai/speak/route';
import { PUBLIC_API_ROUTES } from '@/lib/auth/public-api-routes';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => { const at = l.indexOf('//'); return at === -1 ? l : l.slice(0, at); })
    .join('\n');
}

/** Каталог ключа, каким его увидела проба с прода 24.09. */
const PROD_TTS_CATALOG = [
  'qwen-plus', 'qwen-vl-max',
  'qwen3-tts-flash', 'qwen3-tts-flash-2025-09-18', 'qwen3-tts-flash-2025-11-27',
  'qwen3-tts-flash-realtime', 'qwen3-tts-flash-realtime-2025-09-18',
  'qwen3-tts-instruct-flash', 'qwen3-tts-instruct-flash-2026-01-26', 'qwen3-tts-instruct-flash-realtime',
  'qwen3-tts-vc-2026-01-22', 'qwen3-tts-vc-realtime-2025-11-27',
  'qwen3-tts-vd-2026-01-26', 'qwen3-tts-vd-realtime-2025-12-16',
];

const COMPAT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const wav = (bytes: number) => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'audio/wav' } });

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
function route(handler: (url: string, init?: RequestInit) => Response) {
  fetchMock.mockImplementation(async (url, init) => handler(String(url), init));
}
/** Счастливый путь провайдера: каталог, синтез со ссылкой, файл. */
function happyProvider(audioBytes = 50_000, usage: unknown = { input_tokens: 30, output_tokens: 400 }) {
  route((url) => {
    if (url.endsWith('/models')) return json({ data: PROD_TTS_CATALOG.map((id) => ({ id })) });
    if (url.includes('multimodal-generation')) return json({ output: { audio: { url: 'http://oss.example/a.wav' } }, usage });
    if (url === 'http://oss.example/a.wav') return wav(audioBytes);
    throw new Error(`непредусмотренный адрес ${url}`);
  });
}
const synthCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('multimodal-generation'));

let ipSeq = 0;
const speakReq = (text: unknown, ip = `10.0.0.${++ipSeq}`) => new NextRequest('https://vedarai.ru/api/ai/speak', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify({ text }),
});

beforeEach(() => {
  fetchMock.mockReset();
  logSpeechUsage.mockReset().mockResolvedValue(true);
  vi.stubGlobal('fetch', fetchMock);
  getQwenConfig.mockReturnValue({ apiKey: 'sk-test', base: COMPAT, model: 'qwen-plus' });
  resetSpeechCatalogCache();
  resetSpeakDailyCounter();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('модель — из каталога, основная', () => {
  it('из настоящего каталога прода выбирается qwen3-tts-flash', () => {
    expect(pickSpeechModel(PROD_TTS_CATALOG)).toBe('qwen3-tts-flash');
  });

  it('realtime, instruct, клон, дизайн и датированные снимки не выбираются', () => {
    expect(pickSpeechModel([
      'x-tts-flash-realtime', 'x-tts-instruct-flash', 'x-tts-vc-2026-01-22', 'x-tts-vd-2026-01-26', 'x-tts-flash-2025-09-18',
    ])).toBeNull();
  });

  it('синтеза в каталоге нет — null, а не имя по памяти', () => {
    expect(pickSpeechModel(['qwen-plus', 'qwen-vl-max'])).toBeNull();
  });

  it('id модели в коде синтеза не зашит', () => {
    // Метка провайдера 'qwen-tts' для failure-trace — не модель; id моделей
    // синтеза несут вариант после tts (tts-flash, tts-vc…) — такой литерал запрещён.
    expect(codeOnly(read('lib/ai/tts.ts'))).not.toMatch(/['"`][a-z0-9.-]*tts-[a-z0-9.-]*['"`]/i);
  });

  it('env QWEN_TTS_MODEL сильнее каталога — каталог тогда не спрашивается', async () => {
    vi.stubEnv('QWEN_TTS_MODEL', 'chosen-tts');
    happyProvider();
    const r = await synthesizeSpeech('Привет');
    expect(r.status).toBe('ok');
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/models'))).toBe(false);
    expect(JSON.parse(String(synthCalls()[0][1]?.body)).model).toBe('chosen-tts');
  });
});

describe('текст для голоса', () => {
  it('разметка, эмодзи и адреса не произносятся', () => {
    const { text } = prepareSpeechText('**Важно:** возьмите воду \u{1F4A7}. Подробнее: https://vedarai.ru/routes/1');
    expect(text).toBe('Важно: возьмите воду . Подробнее:');
  });

  it('короткий текст не режется', () => {
    expect(prepareSpeechText('Вулкан Авачинский.')).toEqual({ text: 'Вулкан Авачинский.', truncated: false });
  });

  it('длинный режется по концу предложения, и это признано', () => {
    const sentence = 'Тропа идёт вдоль ручья и поднимается к седловине. ';
    const { text, truncated } = prepareSpeechText(sentence.repeat(60));
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(SPEECH_MAX_CHARS);
    expect(text.endsWith('.')).toBe(true);
  });
});

describe('синтез: три исхода', () => {
  it('ok — только когда файл скачан и в нём есть байты; расход записан', async () => {
    happyProvider(48_000);
    const r = await synthesizeSpeech('Проверка');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.audio.byteLength).toBe(48_000);
      expect(r.model).toBe('qwen3-tts-flash');
    }
    expect(logSpeechUsage).toHaveBeenCalledWith('qwen3-tts-flash', { input_tokens: 30, output_tokens: 400 });
  });

  it('файл пустой — не голос', async () => {
    happyProvider(40);
    expect((await synthesizeSpeech('Проверка')).status).toBe('refused');
  });

  it('провайдер отказал — refused с текстом отказа', async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: PROD_TTS_CATALOG.map((id) => ({ id })) });
      return new Response('{"code":"Throttling"}', { status: 429 });
    });
    const r = await synthesizeSpeech('Проверка');
    expect(r).toMatchObject({ status: 'refused' });
    if (r.status === 'refused') expect(r.reason).toContain('Throttling');
  });

  it('ключа нет — unavailable, в сеть не ходит', async () => {
    getQwenConfig.mockReturnValue({ apiKey: null, base: COMPAT, model: 'qwen-plus' });
    expect((await synthesizeSpeech('Проверка')).status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('сеть не дошла — unavailable, а не «голоса нет»', async () => {
    route(() => { throw new TypeError('fetch failed'); });
    expect((await synthesizeSpeech('Проверка')).status).toBe('unavailable');
  });

  it('провайдер не отдал usage — это сказано в лог, а не проглочено', async () => {
    logSpeechUsage.mockResolvedValue(false);
    happyProvider(48_000, undefined);
    await synthesizeSpeech('Проверка');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('расход не записан'), 'qwen3-tts-flash');
  });
});

describe('роут /api/ai/speak', () => {
  it('отдаёт аудио и признаётся, обрезан ли текст', async () => {
    happyProvider(48_000);
    const res = await POST(speakReq('Тропа идёт вдоль ручья. '.repeat(100)));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('X-Speech-Truncated')).toBe('1');
    expect((await res.arrayBuffer()).byteLength).toBe(48_000);
  });

  it('пустой текст — 400 со словами, провайдер не зовётся', async () => {
    const res = await POST(speakReq('   '));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('отказ провайдера — 502, а не 200 с тишиной', async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: PROD_TTS_CATALOG.map((id) => ({ id })) });
      return new Response('nope', { status: 400 });
    });
    const res = await POST(speakReq('Проверка'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Не удалось озвучить/);
  });

  it('частота по IP: седьмая озвучка за минуту с одного адреса — 429', async () => {
    happyProvider();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await POST(speakReq('Проверка', '192.0.2.77'))).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses[6]).toBe(429);
  });

  it('дневной потолок: исчерпан — 429 со словами, провайдер не зовётся', async () => {
    vi.stubEnv('TTS_DAILY_MAX', '2');
    happyProvider();
    expect((await POST(speakReq('раз'))).status).toBe(200);
    expect((await POST(speakReq('два'))).status).toBe(200);
    const before = synthCalls().length;
    const res = await POST(speakReq('три'));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/исчерпана/);
    expect(synthCalls().length).toBe(before);
  });

  it('потолок по умолчанию назван числом', () => {
    expect(DEFAULT_DAILY_MAX).toBeGreaterThan(0);
  });

  it('объявлен публичным только на POST — как и сам чат, открыт анонимам', () => {
    expect(PUBLIC_API_ROUTES['/api/ai/speak']).toEqual(['POST']);
  });
});

describe('кнопка «Озвучить»', () => {
  const BTN = read('components/kuzmich/SpeakButton.tsx');

  it('есть в обоих чатах и только у ответов Кузьмича', () => {
    for (const p of ['app/kuzmich/_KuzmichClient.tsx', 'components/kuzmich/KuzmichWidget.tsx']) {
      expect(read(p), p).toMatch(/msg\.role === 'assistant' && msg\.content && <SpeakButton text=\{msg\.content\} \/>/);
    }
  });

  it('отказ виден словами, обрезка признана', () => {
    expect(BTN).toMatch(/role="status"/);
    expect(BTN).toMatch(/X-Speech-Truncated/);
    expect(BTN).toMatch(/Озвучено начало ответа/);
  });

  it('язык Ведара: токены вместо hex, lucide, тач-цель 44px, без эмодзи', () => {
    const code = codeOnly(BTN);
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(code).toMatch(/from 'lucide-react'/);
    expect(code).toMatch(/min-h-\[44px\]/);
    expect(code).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(code).not.toMatch(/@keyframes|font-black/);
  });
});
