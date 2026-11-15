/**
 * Проба голоса Кузьмича (#1992): приговор по байтам аудио, а не по HTTP 200.
 *
 * Сторожу держать обещания шапки роута:
 * 1. «speaks» — только когда аудио скачано и в нём есть байты. Ответ
 *    провайдера без звука — отдельный исход, не голос.
 * 2. «Не смог проверить» не выдаётся за «голоса нет» и наоборот (§4.0).
 * 3. Модель не зашита в код — берётся из каталога ключа (§8).
 * 4. Не больше двух синтезов за прогон, в БД не ходит, наружу не пишет.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';

const { getQwenConfig } = vi.hoisted(() => ({ getQwenConfig: vi.fn() }));
vi.mock('@/lib/ai/providers', () => ({ getQwenConfig }));

import {
  GET, nativeBase, MAX_SYNTH_ATTEMPTS, PROBE_PHRASE, DEEPSEEK_TTS_URL, DEEPSEEK_CONTROL_PHRASE, wavSeconds,
} from '@/app/api/cron/voice-probe/route';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/voice-probe/route.ts'), 'utf-8');

/** Код без комментариев: в шапке слово tts стоит по делу. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => { const at = l.indexOf('//'); return at === -1 ? l : l.slice(0, at); })
    .join('\n');
}
const COMPAT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const SECRET = 'test-cron-secret';
const req = (qs = '', auth = true) => new NextRequest(
  `https://vedarai.ru/api/cron/voice-probe${qs}`,
  { headers: auth ? { authorization: `Bearer ${SECRET}` } : {} },
);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const audio = (bytes: number, status = 200) => new Response(new Uint8Array(bytes), { status, headers: { 'content-type': 'audio/wav' } });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
function route(handler: Handler) {
  fetchMock.mockImplementation(async (url, init) => handler(String(url), init));
}
const synthCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('multimodal-generation'));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('CRON_SECRET', SECRET);
  getQwenConfig.mockReturnValue({ apiKey: 'sk-test', base: COMPAT, model: 'qwen-plus' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('приговор — по байтам аудио', () => {
  it('ссылка на аудио скачалась с байтами — speaks, ссылка отдана на прослушивание', async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'qwen-plus' }, { id: 'some-tts-flash' }] });
      if (url.includes('multimodal-generation')) return json({ output: { audio: { url: 'https://oss.example/a.wav' } } });
      if (url === 'https://oss.example/a.wav') return audio(48_000);
      throw new Error(`непредусмотренный адрес ${url}`);
    });
    const body = await (await GET(req())).json();
    expect(body.verdict).toBe('speaks');
    expect(body.listen).toBe('https://oss.example/a.wav');
    expect(body.catalog.tts_models).toEqual(['some-tts-flash']);
    expect(body.attempts[0].audio_bytes).toBe(48_000);
  });

  it('200 без output.audio — answers_without_audio, а не голос', async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'x-tts' }] });
      return json({ output: { text: 'ok' } });
    });
    const body = await (await GET(req())).json();
    expect(body.verdict).toBe('answers_without_audio');
    expect(body.listen).toBeNull();
  });

  it('ссылка есть, но файл пустой — не голос', async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'x-tts' }] });
      if (url.includes('multimodal-generation')) return json({ output: { audio: { url: 'https://oss.example/e.wav' } } });
      return audio(40);
    });
    expect((await (await GET(req())).json()).verdict).toBe('answers_without_audio');
  });

  it('base64 в ответе мерится так же, как файл по ссылке', async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'x-tts' }] });
      return json({ output: { audio: { data: Buffer.alloc(5000).toString('base64') } } });
    });
    expect((await (await GET(req())).json()).verdict).toBe('speaks');
  });
});

describe('три исхода «нет», и они различимы', () => {
  it('провайдер отказал — refused с текстом отказа', async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'x-tts' }] });
      return new Response('{"code":"AccessDenied","message":"no access"}', { status: 403 });
    });
    const body = await (await GET(req())).json();
    expect(body.verdict).toBe('refused');
    expect(body.attempts[0].error).toContain('AccessDenied');
  });

  it('каталог прочитан, синтеза в нём нет — no_tts_models, синтез не зовётся', async () => {
    route(() => json({ data: [{ id: 'qwen-plus' }, { id: 'qwen-vl-max' }] }));
    const body = await (await GET(req())).json();
    expect(body.verdict).toBe('no_tts_models');
    expect(synthCalls()).toHaveLength(0);
  });

  it('до провайдера не дошли — could_not_check, а не «голоса нет»', async () => {
    route(() => { throw new TypeError('fetch failed'); });
    const body = await (await GET(req())).json();
    expect(body.verdict).toBe('could_not_check');
    expect(body.catalog.read).toBe(false);
  });

  it('ключа нет — could_not_check с причиной, в сеть не ходит', async () => {
    getQwenConfig.mockReturnValue({ apiKey: null, base: COMPAT, model: 'qwen-plus' });
    const body = await (await GET(req())).json();
    expect(body.verdict).toBe('could_not_check');
    expect(body.reason).toMatch(/DASHSCOPE_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('модель — из каталога, перебор ограничен', () => {
  it('id модели синтеза в коде не зашит', () => {
    expect(codeOnly(ROUTE)).not.toMatch(/['"`][a-z0-9.-]*tts[a-z0-9.-]*['"`]/i);
  });

  it(`не больше ${MAX_SYNTH_ATTEMPTS} синтезов, даже если каталог длиннее и все отказывают`, async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: ['a-tts', 'b-tts', 'c-tts', 'd-tts'].map((id) => ({ id })) });
      return new Response('nope', { status: 400 });
    });
    await GET(req());
    expect(synthCalls()).toHaveLength(MAX_SYNTH_ATTEMPTS);
  });

  it('первый заговоривший останавливает перебор', async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'a-tts' }, { id: 'b-tts' }] });
      if (url.includes('multimodal-generation')) return json({ output: { audio: { url: 'https://oss.example/a.wav' } } });
      return audio(9000);
    });
    await GET(req());
    expect(synthCalls()).toHaveLength(1);
  });

  it('ручной выбор модели параметром уходит в запрос как есть', async () => {
    route((url) => {
      if (url.endsWith('/models')) return json({ data: [] });
      if (url.includes('multimodal-generation')) return json({ output: { audio: { url: 'https://oss.example/a.wav' } } });
      return audio(9000);
    });
    const body = await (await GET(req('?model=chosen-tts&voice=Ethan'))).json();
    const sent = JSON.parse(String(synthCalls()[0][1]?.body));
    expect(sent).toMatchObject({ model: 'chosen-tts', input: { text: PROBE_PHRASE, voice: 'Ethan' } });
    expect(body.verdict).toBe('speaks');
  });

  it('нативный адрес — тот же хост, что текстовый: другой регион значил бы другой ключ', () => {
    expect(nativeBase(COMPAT)).toBe('https://dashscope-intl.aliyuncs.com');
    expect(nativeBase('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('https://dashscope.aliyuncs.com');
  });
});

describe('только читает', () => {
  it('в БД не ходит и наружу не публикует', () => {
    // Перепись возможностей видит db_* через providers.ts (там logLLMUsage);
    // сам роут базу не трогает — это держит проверка ниже.
    expect(ROUTE).not.toMatch(/db-pool|@\/lib\/database|sendMessage|telegram/i);
    expect(ROUTE).toMatch(/export async function GET\(/);
    expect(ROUTE).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\(/);
  });

  it('без секрета — 401, в сеть не ходит', async () => {
    const res = await GET(req('', false));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('объявлена ручной непишущей', () => {
    expect(MANUAL_ENDPOINTS['voice-probe']).toMatchObject({ kind: 'manual', writes: false });
  });
});

/** WAV: 24 кГц, 16 бит, моно — 48 000 байт в секунду, как отдаёт DeepSeek. */
function wav(seconds: number, dataSizeField?: number): Uint8Array {
  const dataBytes = Math.round(seconds * 48_000);
  const buf = new Uint8Array(44 + dataBytes);
  const v = new DataView(buf.buffer);
  const put = (o: number, t: string) => { for (let i = 0; i < 4; i += 1) buf[o + i] = t.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 24_000, true); v.setUint32(28, 48_000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  put(36, 'data'); v.setUint32(40, dataSizeField ?? dataBytes, true);
  return buf;
}
const wavResponse = (seconds: number) => new Response(wav(seconds), { status: 200, headers: { 'content-type': 'audio/wav' } });

describe('DeepSeek (?provider=deepseek, слово владельца 15.11 «deepseek добавили голос»)', () => {
  beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'ds-test'); });
  const dsCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === DEEPSEEK_TTS_URL);

  it('русская и английская фразы: звук, длительность по заголовку WAV, Qwen не зовётся', async () => {
    route((url, init) => {
      if (url !== DEEPSEEK_TTS_URL) throw new Error(`непредусмотренный адрес ${url}`);
      const text = (JSON.parse(String(init?.body)) as { text: string }).text;
      return wavResponse(text === PROBE_PHRASE ? 6.5 : 5);
    });
    const body = await (await GET(req('?provider=deepseek'))).json();
    expect(body.provider).toBe('deepseek');
    expect(body.verdict).toBe('speaks');
    expect(body.russian_in_docs).toBe(false);
    expect(body.attempts.map((a: { lang: string; audio_seconds: number }) => [a.lang, a.audio_seconds])).toEqual([['ru', 6.5], ['en', 5]]);
    expect(body.seconds_per_char.ru).toBeCloseTo(6.5 / PROBE_PHRASE.length, 3);
    expect(body.seconds_per_char.en).toBeCloseTo(5 / DEEPSEEK_CONTROL_PHRASE.length, 3);
    const [, init] = dsCalls()[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ text: PROBE_PHRASE, voice_id: 'stella', format: 'wav' });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ds-test');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('dashscope') || String(u).endsWith('/models'))).toBe(false);
  });

  it('русская фраза — отказ провайдера, английская — звук: refused с текстом отказа', async () => {
    route((url, init) => {
      const text = (JSON.parse(String(init?.body)) as { text: string }).text;
      if (text === PROBE_PHRASE) return new Response('{"error":"Content Exists Risk"}', { status: 400 });
      return wavResponse(5);
    });
    const body = await (await GET(req('?provider=deepseek'))).json();
    expect(body.verdict).toBe('refused');
    expect(body.attempts[0]).toMatchObject({ lang: 'ru', http: 400, outcome: 'refused' });
    expect(body.attempts[0].error).toContain('Content Exists Risk');
    expect(body.attempts[1]).toMatchObject({ lang: 'en', outcome: 'audio' });
  });

  it('200 с телом короче порога — не голос', async () => {
    route(() => new Response(new Uint8Array(20), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    expect((await (await GET(req('?provider=deepseek'))).json()).verdict).toBe('answers_without_audio');
  });

  it('до провайдера не дошли — could_not_check, а не «голоса нет»', async () => {
    route(() => { throw new TypeError('fetch failed'); });
    const body = await (await GET(req('?provider=deepseek'))).json();
    expect(body.verdict).toBe('could_not_check');
    expect(body.attempts[0].error).toContain('fetch failed');
  });

  it('ключа нет — could_not_check с причиной, в сеть не ходит', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const body = await (await GET(req('?provider=deepseek'))).json();
    expect(body.verdict).toBe('could_not_check');
    expect(body.reason).toMatch(/DEEPSEEK_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('голос — только из документации: чужое имя заменяется на stella', async () => {
    route(() => wavResponse(5));
    await GET(req('?provider=deepseek&voice=../../x'));
    expect(JSON.parse(String(dsCalls()[0]![1]?.body)).voice_id).toBe('stella');
    fetchMock.mockClear();
    await GET(req('?provider=deepseek&voice=tide'));
    expect(JSON.parse(String(dsCalls()[0]![1]?.body)).voice_id).toBe('tide');
  });

  it('без секрета — 401, в сеть не ходит', async () => {
    const res = await GET(req('?provider=deepseek', false));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('длительность WAV', () => {
  it('считается по байтам после заголовка: поле размера потокового WAV бывает заглушкой', () => {
    expect(wavSeconds(wav(2))).toBe(2);
    expect(wavSeconds(wav(1.5, 0xffffffff))).toBe(1.5);
  });
  it('не WAV и обрывок — null, а не ноль секунд', () => {
    expect(wavSeconds(new Uint8Array(100))).toBeNull();
    expect(wavSeconds(wav(1).slice(0, 30))).toBeNull();
  });
});
