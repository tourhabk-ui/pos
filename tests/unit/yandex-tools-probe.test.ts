// @vitest-environment node
/**
 * Проба YandexGPT с инструментами (06.11, владелец: «Делай»).
 *
 * С прода у цикла инструментов Кузьмича живая одна нога — DeepSeek
 * (ai-debug run 14: Qwen — исчерпанная бесплатная квота, xAI и OpenRouter —
 * гео). YandexGPT с прода отвечает, но зовёт ли он инструмент через адрес,
 * совместимый с OpenAI, документация прямо не говорит. Сторож держит пробу:
 * вызов инструмента — «годится», ответ текстом — «не годится» словами, а не
 * успехом, отказ — с кодом и телом; ключа нет — «нечем спросить»; запрос
 * несёт инструмент, адрес совместимости и каталог.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyYandexToolsReply, probeYandexTools, YANDEX_TOOLS_PROBE_TOOL } from '@/lib/ai/providers';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YANDEX_API_KEY;
  delete process.env.YANDEX_FOLDER_ID;
});

describe('ответ пробы YandexGPT с инструментами', () => {
  it('позвал инструмент — годится, имя инструмента названо', () => {
    const r = classifyYandexToolsReply(200, {
      choices: [{ message: { content: null, tool_calls: [{ function: { name: 'get_safety_status', arguments: '{}' } }] } }],
    }, 900);
    expect(r).toMatchObject({ provider: 'yandex:tools', status: 'success', answer_preview: 'инструмент позван: get_safety_status' });
  });

  it('ответил текстом без вызова — не успех, а «не годится» словами', () => {
    const r = classifyYandexToolsReply(200, { choices: [{ message: { content: 'Обстановка спокойная.' } }] }, 700);
    expect(r.status).toBe('empty_response');
    expect(r.error).toMatch(/инструмент не позвал/);
  });

  it('отказ провайдера — код и тело, а не «пусто»', () => {
    const r = classifyYandexToolsReply(400, { error: { message: 'tools is not supported' } }, 120);
    expect(r).toMatchObject({ status: 'http_error', http_status: 400 });
    expect(r.error).toMatch(/tools is not supported/);
  });

  it('ни текста, ни вызова — пустой ответ с телом', () => {
    expect(classifyYandexToolsReply(200, { choices: [] }, 50).status).toBe('empty_response');
  });
});

describe('запрос пробы', () => {
  it('без ключа или каталога — «нечем спросить», сеть не трогается', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await probeYandexTools()).status).toBe('no_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('адрес совместимости, модель каталога, инструмент и выбор auto', async () => {
    process.env.YANDEX_API_KEY = 'test-key';
    process.env.YANDEX_FOLDER_ID = 'b1gtestfolder';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: 'get_safety_status' } }] } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeYandexTools();
    expect(r.status).toBe('success');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.api.cloud.yandex.net/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt://b1gtestfolder/yandexgpt/latest');
    expect(body.tools).toEqual([YANDEX_TOOLS_PROBE_TOOL]);
    expect(body.tool_choice).toBe('auto');
    expect(JSON.stringify(body)).not.toMatch(/\+7|@/);
  });
});
