/**
 * Самолечение MAX-бота Кузьмича (/api/cron/max-webhook).
 *
 * Бот в MAX живёт только на webhook-подписке. Один раз она потерялась — и бот
 * замолчал на месяц без единого сигнала. Этот эндпоинт держит подписку живой.
 * Сторож фиксирует контракт: не трогать, если подписка на месте; регистрировать
 * заново, если её нет; закрыт cron-секретом.
 *
 * MAX здесь — подделка с состоянием (`fakeMax`): GET отдаёт текущий список,
 * POST добавляет, DELETE по `?url=` снимает. Так проверяется не «крон позвал
 * DELETE», а «подписка снята и ожидаемая осталась» — и что крон говорит
 * правду, когда MAX ответил `{success:false}` при HTTP 200, ответил HTTP 200
 * без поля `success` или не JSON («исход не проверен»), снятие не подействовало
 * или задело ожидаемый адрес.
 *
 * Чужой хост на адресе вебхука Кузьмича или с текущим ключом в адресе —
 * красный прогон (`foreign_webhooks`, только хост) и отметка отказа с
 * причиной: копия приложения там получает апдейты людей и с ключом отвечает
 * им. Иные интеграции чужих хостов — сведение, без красного.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const WEBHOOK = 'https://vedarai.ru/api/max/kuzmich';

type Reply = Response | Error;

/**
 * MAX с состоянием. `onDelete`/`onPost` подменяют ответ (и действие) MAX;
 * по умолчанию POST добавляет адрес, DELETE снимает ровно его.
 */
function fakeMax(initial: string[], opts: {
  onDelete?: (url: string, subs: Set<string>) => Reply;
  onPost?: (url: string, subs: Set<string>) => Reply;
  onList?: (n: number) => Reply | null;
} = {}) {
  const subs = new Set(initial);
  const calls: string[] = [];
  let lists = 0;
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    let reply: Reply;
    if (method === 'GET') {
      lists += 1;
      reply = opts.onList?.(lists) ?? new Response(JSON.stringify({ subscriptions: [...subs].map((u) => ({ url: u })) }), { status: 200 });
    } else if (method === 'POST') {
      const target = (JSON.parse(String(init?.body)) as { url: string }).url;
      reply = opts.onPost ? opts.onPost(target, subs) : (subs.add(target), new Response(JSON.stringify({ success: true }), { status: 200 }));
    } else {
      const target = decodeURIComponent(url.split('url=')[1] ?? '');
      reply = opts.onDelete ? opts.onDelete(target, subs) : (subs.delete(target), new Response(JSON.stringify({ success: true }), { status: 200 }));
    }
    if (reply instanceof Error) throw reply;
    return reply;
  });
  vi.doMock('@/lib/max/max-fetch', () => ({ maxFetch: fetchMock }));
  return { subs, calls, deleted: () => calls.filter((c) => c.startsWith('DELETE')).map((c) => decodeURIComponent(c.split('url=')[1] ?? '')) };
}

const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });

async function callRoute() {
  const { GET } = await import('@/app/api/cron/max-webhook/route');
  const req = new Request('https://vedarai.ru/api/cron/max-webhook', {
    headers: { authorization: 'Bearer test-secret' },
  });
  return GET(req);
}

describe('/api/cron/max-webhook — самолечение подписки', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = 'test-secret';
    process.env.MAX_BOT_TOKEN = 'max-token';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://vedarai.ru';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/max/max-fetch');
  });

  it('401 без валидного cron-секрета', async () => {
    const { GET } = await import('@/app/api/cron/max-webhook/route');
    const res = await GET(new Request('https://vedarai.ru/api/cron/max-webhook'));
    expect(res.status).toBe(401);
  });

  it('подписка на месте → noop, повторно не регистрирует', async () => {
    const fetchMock = vi.fn(async (_url: string, opts?: { method?: string }) => {
      if (!opts || opts.method === 'GET' || opts.method === undefined) {
        return new Response(JSON.stringify({ subscriptions: [{ url: WEBHOOK }] }), { status: 200 });
      }
      throw new Error('POST не должен вызываться, когда подписка уже есть');
    });
    // Запросы к API MAX идут через maxFetch (корень Минцифры) — подменяем его.
    vi.doMock('@/lib/max/max-fetch', () => ({ maxFetch: fetchMock }));

    const res = await callRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.action).toBe('noop');
    // ровно один вызов — только GET-проверка, без POST-регистрации
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('подписки нет → регистрирует заново, и повторный список это подтверждает', async () => {
    const max = fakeMax([]);
    const res = await callRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.action).toBe('registered');
    expect([...max.subs]).toEqual([WEBHOOK]);
    expect(body.subscriptions_after).toBe(1);
  });

  it('появился секрет: адрес с секретом регистрируется, наш старый без секрета снимается, чужой остаётся', async () => {
    process.env.MAX_WEBHOOK_SECRET = 'sec';
    const max = fakeMax([WEBHOOK, 'https://other.example/hook']);
    try {
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.action).toBe('registered');
      // Ровно один: наш старый адрес без секрета. Чужой не тронут.
      expect(max.deleted()).toEqual([WEBHOOK]);
      // Снятие — только ПОСЛЕ регистрации нового: иначе бот остался бы без подписки.
      expect(max.calls.findIndex((c) => c.startsWith('POST'))).toBeLessThan(max.calls.findIndex((c) => c.startsWith('DELETE')));
      expect([...max.subs].sort()).toEqual([`${WEBHOOK}?s=sec`, 'https://other.example/hook'].sort());
      expect(JSON.stringify(body)).not.toContain('sec&');
      expect(body.stale_removed).toEqual([WEBHOOK]);
      expect(body.subscriptions_after).toBe(2);
    } finally {
      delete process.env.MAX_WEBHOOK_SECRET;
    }
  });

  it('вторая подписка на прежнем хосте tourhab.ru (без ключа) снимается; чужая интеграция показана хостом, без пути и ключей', async () => {
    process.env.MAX_WEBHOOK_SECRET = 'sec';
    const keyed = `${WEBHOOK}?s=sec`;
    const max = fakeMax([
      keyed,
      'https://tourhab.ru/api/max/kuzmich',
      'https://www.vedarai.ru/api/max/kuzmich/?s=old-key',
      'https://staging.example/max/updates?token=foreign-secret',
    ]);
    try {
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.action).toBe('removed_stale');
      expect(max.deleted().sort()).toEqual(['https://tourhab.ru/api/max/kuzmich', 'https://www.vedarai.ru/api/max/kuzmich/?s=old-key'].sort());
      // Ожидаемый адрес и чужой хост не тронуты.
      expect(max.deleted()).not.toContain(keyed);
      expect([...max.subs].sort()).toEqual([keyed, 'https://staging.example/max/updates?token=foreign-secret'].sort());
      expect(body.other_subscriptions).toEqual(['staging.example (путь и параметры скрыты)']);
      expect(body.foreign_webhooks).toEqual([]);
      expect(body.subscriptions).toBe(4);
      expect(body.subscriptions_after).toBe(2);
      const printed = JSON.stringify(body);
      expect(printed).not.toContain('foreign-secret');
      expect(printed).not.toContain('old-key');
      expect(printed).not.toContain('s=sec');
    } finally {
      delete process.env.MAX_WEBHOOK_SECRET;
    }
  });

  it('чужой адрес с ключом в пути — показан хостом, ключ из пути в ответ не попадает', async () => {
    process.env.MAX_WEBHOOK_SECRET = 'sec';
    fakeMax([
      `${WEBHOOK}?s=sec`,
      'https://hook.eu2.make.com/abcd1234secret',
      'https://hooks.example/n8n/7f3a9c2e-1b4d-4e5f-9a8b-0c1d2e3f4a5b?x=1',
      'https://vedarai.ru/api/max/hook-9f8e7d6c5b4a3f2e',
    ]);
    try {
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.other_subscriptions).toEqual([
        'hook.eu2.make.com (путь скрыт)',
        'hooks.example (путь и параметры скрыты)',
        // Свой хост: слова пути видны, похожее на ключ — нет.
        'vedarai.ru/api/max/[скрыто]',
      ]);
      const printed = JSON.stringify(body);
      for (const secret of ['abcd1234secret', '7f3a9c2e', '9f8e7d6c5b4a3f2e', 'n8n']) expect(printed).not.toContain(secret);
    } finally {
      delete process.env.MAX_WEBHOOK_SECRET;
    }
  });

  describe('снятие засчитывается по ответу MAX и повторному списку', () => {
    const KEYED = `${WEBHOOK}?s=sec`;
    const OLD = 'https://tourhab.ru/api/max/kuzmich';
    let errorLog: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      process.env.MAX_WEBHOOK_SECRET = 'sec';
      errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => { delete process.env.MAX_WEBHOOK_SECRET; });
    const logged = () => errorLog.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

    it('DELETE: HTTP 200 и {success:false} — не «снята», причина словами MAX, прогон красный', async () => {
      const max = fakeMax([KEYED, OLD], {
        onDelete: () => new Response(JSON.stringify({ success: false, message: 'subscription.not.found' }), { status: 200 }),
      });
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.action).toBe('noop');
      expect(body.stale_removed).toEqual([]);
      expect(body.stale_failed).toEqual([{ url: OLD, reason: expect.stringContaining('success: false: subscription.not.found') }]);
      expect(body.subscriptions_after).toBe(2);
      expect([...max.subs].sort()).toEqual([KEYED, OLD].sort());
      expect(logged()).toContain('subscription.not.found');
    });

    it('MAX ответил «снята», а подписка осталась — отказ по повторному списку, не «снята»', async () => {
      fakeMax([KEYED, OLD], { onDelete: () => ok() });
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.stale_removed).toEqual([]);
      expect(body.stale_failed).toEqual([{ url: OLD, reason: expect.stringContaining('осталась в списке') }]);
    });

    it('снятие по ?url= задело ожидаемую подписку — она ставится заново сразу, прогон красный', async () => {
      const max = fakeMax([KEYED, OLD], { onDelete: (_u, subs) => { subs.clear(); return ok(); } });
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(String(body.error)).toContain('ожидаемой подписки нет в списке после правки; поставлена заново');
      // Бот не остаётся без подписки до следующего прогона.
      expect([...max.subs]).toEqual([KEYED]);
      expect(max.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
      expect(JSON.stringify(body)).not.toContain('s=sec');
    });

    it('сеть на DELETE — в причине код сети, ключа нет ни в ответе, ни в логе', async () => {
      const keyedOld = 'https://vedarai.ru/api/max/kuzmich?s=old-key';
      fakeMax([KEYED, keyedOld], {
        onDelete: (u) => Object.assign(new Error(`fetch failed for ${u}`), { cause: Object.assign(new Error('unable to get issuer'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }) }),
      });
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.stale_failed).toEqual([{ url: 'https://vedarai.ru/api/max/kuzmich?s=[secret]', reason: expect.stringContaining('UNABLE_TO_GET_ISSUER_CERT_LOCALLY') }]);
      for (const text of [JSON.stringify(body), logged()]) {
        expect(text).not.toContain('old-key');
        expect(text).not.toContain('s=sec');
      }
    });

    it('DELETE: HTTP 404 — код в причине', async () => {
      fakeMax([KEYED, OLD], { onDelete: () => new Response('not found', { status: 404 }) });
      const body = await (await callRoute()).json();
      expect(body.stale_failed).toEqual([{ url: OLD, reason: 'HTTP 404' }]);
    });

    it('повторный список не прочитан — «исход не проверен», прогон красный', async () => {
      fakeMax([KEYED, OLD], { onList: (n) => (n > 1 ? new Response('{}', { status: 503 }) : null) });
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.step).toBe('verify');
      expect(String(body.error)).toContain('исход не проверен: HTTP 503');
    });

    it('POST: HTTP 200 и {success:false} — register_failed с причиной, старое не снимается', async () => {
      const max = fakeMax([OLD], {
        onPost: () => new Response(JSON.stringify({ success: false, message: `bad url ${KEYED}` }), { status: 200 }),
      });
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.action).toBe('register_failed');
      expect(String(body.error)).toContain('success: false: bad url');
      expect(JSON.stringify(body)).not.toContain('s=sec');
      expect(max.deleted()).toEqual([]);
      expect([...max.subs]).toEqual([OLD]);
    });

    // Третий исход ответа MAX (§4.0): HTTP 200, а поля success нет или тело
    // не JSON — не «поставлена» и не «снята», а «не проверено».
    const UNVERIFIED: Array<[string, string]> = [
      ['{}', 'в ответе нет поля success — исход не проверен'],
      ['OK', 'ответ не разобран — исход не проверен'],
    ];

    it.each(UNVERIFIED)('POST: HTTP 200 и %s — register_failed «исход не проверен», старое не снимается', async (reply, reason) => {
      const max = fakeMax([OLD], { onPost: () => new Response(reply, { status: 200 }) });
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.action).toBe('register_failed');
      expect(body.error).toBe(`HTTP 200, ${reason}`);
      expect(max.deleted()).toEqual([]);
      expect([...max.subs]).toEqual([OLD]);
    });

    it.each(UNVERIFIED)('DELETE: HTTP 200 и %s — в stale_failed «исход не проверен», не в stale_removed', async (reply, reason) => {
      fakeMax([KEYED, OLD], { onDelete: () => new Response(reply, { status: 200 }) });
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.stale_removed).toEqual([]);
      expect(body.stale_failed).toEqual([{ url: OLD, reason: `HTTP 200, ${reason}` }]);
      expect(logged()).toContain('исход не проверен');
    });
  });

  describe('чужой вебхук бота — исход «плохо»', () => {
    const KEYED = `${WEBHOOK}?s=current-key`;
    const runs = vi.fn();
    beforeEach(() => {
      process.env.MAX_WEBHOOK_SECRET = 'current-key';
      runs.mockReset();
      vi.doMock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: runs }));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
      delete process.env.MAX_WEBHOOK_SECRET;
      vi.doUnmock('@/lib/agents/cron-heartbeat');
    });
    const failedRun = () => runs.mock.calls.filter((c) => c[2] === 'failed').map((c) => String((c[3] as { error?: string } | undefined)?.error));

    it('чужой хост на пути вебхука Кузьмича — 502 с хостом, без пути и ключа; не снимается; отказ с причиной в отметке', async () => {
      const foreignUrl = 'https://staging.example/api/max/kuzmich?s=staging-own-key';
      const max = fakeMax([KEYED, foreignUrl]);
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.ok).toBe(false);
      expect(body.foreign_webhooks).toEqual([{ host: 'staging.example', sign: 'адрес вебхука Кузьмича' }]);
      expect(body.other_subscriptions).toEqual([]);
      // Чей это хост, решает человек: крон не снимает.
      expect(max.deleted()).toEqual([]);
      expect([...max.subs].sort()).toEqual([KEYED, foreignUrl].sort());
      const printed = JSON.stringify(body);
      expect(printed).not.toContain('staging-own-key');
      expect(printed).not.toContain('current-key');
      expect(JSON.stringify(body.foreign_webhooks)).not.toContain('/');
      expect(runs.mock.calls.map((c) => c[2])).toEqual(['failed']);
      expect(failedRun()[0]).toContain('бот подписан на чужой хост: staging.example (адрес вебхука Кузьмича)');
      expect(failedRun()[0]).not.toContain('staging-own-key');
    });

    it.each([
      ['https://evil.example/collect?s=current-key'],
      ['https://evil.example/collect?k=current-key&x=1'],
      ['https://evil.example/inbox/current-key'],
    ])('текущий ключ в адресе чужого хоста (%s) — 502 с хостом, ключа и пути в ответе нет', async (foreignUrl) => {
      fakeMax([KEYED, foreignUrl]);
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.foreign_webhooks).toEqual([{ host: 'evil.example', sign: 'текущий ключ подписки в адресе' }]);
      expect(body.other_subscriptions).toEqual([]);
      const printed = JSON.stringify(body);
      expect(printed).not.toContain('current-key');
      expect(printed).not.toContain('collect');
      expect(printed).not.toContain('inbox');
      expect(failedRun()[0]).toContain('evil.example (текущий ключ подписки в адресе)');
    });

    it('чужой вебхук рядом с правкой (регистрация и снятие старой) — правка сделана, прогон всё равно красный', async () => {
      const max = fakeMax(['https://tourhab.ru/api/max/kuzmich', 'https://staging.example/api/max/kuzmich']);
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.action).toBe('registered');
      expect(body.stale_removed).toEqual(['https://tourhab.ru/api/max/kuzmich']);
      expect(body.foreign_webhooks).toEqual([{ host: 'staging.example', sign: 'адрес вебхука Кузьмича' }]);
      expect([...max.subs].sort()).toEqual([KEYED, 'https://staging.example/api/max/kuzmich'].sort());
      expect(failedRun()[0]).toContain('staging.example');
    });

    it('иная интеграция чужого хоста (другой путь, без ключа) — сведение в other_subscriptions, прогон зелёный', async () => {
      fakeMax([KEYED, 'https://hook.eu2.make.com/abcd1234', 'https://evil.example/collect?s=old-key']);
      const res = await callRoute();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.foreign_webhooks).toEqual([]);
      expect(body.other_subscriptions).toEqual(['hook.eu2.make.com (путь скрыт)', 'evil.example (путь и параметры скрыты)']);
      expect(runs.mock.calls.map((c) => c[2])).toEqual(['success']);
    });
  });

  it('нет MAX_BOT_TOKEN → 500, не молчит зелёным', async () => {
    delete process.env.MAX_BOT_TOKEN;
    const res = await callRoute();
    expect(res.status).toBe(500);
  });
});
