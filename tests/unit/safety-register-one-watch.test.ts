/**
 * Волна 0 плана МЧС (docs/safety/MCHS_PLAN.md): форма `/register` не плодит
 * контроли и не говорит неправды.
 *
 * До 10.11:
 *  - форма слала два запроса, и сервер писал запись на каждый — «Я вернулся»
 *    закрывал одну, по второй сторож поднимал тревогу (С1);
 *  - лист «заявления» набирался шрифтом без кириллицы (С3);
 *  - экран говорил «Маршрут зарегистрирован», «мы напомним», «Госуслуги» (С4);
 *  - на карточке маршрута было своё окно — вторая дверь в контроль (С2).
 *
 * Роут судится вызовом, лист — настоящим PDF; кнопка карточки маршрута —
 * рендером в mchs-block-one-door.test.tsx (PDF в среде браузера не собирается).
 * Регулярка по исходнику — только запреты.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  once: vi.fn(),
  plain: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.poolQuery(...a) } }));

vi.mock('@/lib/safety/trip-watch', async (importOriginal) => ({
  // Настоящий модуль — ради submitKeyHash: что уходит в базу вместо ключа, судится им.
  ...(await importOriginal<typeof import('@/lib/safety/trip-watch')>()),
  createTripWatchOnce: (...a: unknown[]) => m.once(...a),
  createTripWatch: (...a: unknown[]) => m.plain(...a),
}));
vi.mock('@/lib/auth', () => ({
  verifyAuth: async () => ({ isAuthenticated: false, userId: null, role: null }),
}));

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Дата по Камчатке через `days` суток — форма не принимает прошедшие. */
function kamchatkaDay(days: number): string {
  const d = new Date(Date.now() + 12 * 3600_000 + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function body(over: Record<string, unknown> = {}) {
  return {
    route_name: 'Авачинский перевал',
    start_date: kamchatkaDay(2),
    end_date: kamchatkaDay(3),
    expected_return_time: '19:00',
    region: 'Камчатский край',
    group_size: 2,
    group_members: [{ name: 'Тест Второй', phone: '+70000000001', birth_year: 1990 }, { name: '  ' }],
    leader_name: 'Тест',
    leader_phone: '+70000000000',
    emergency_contact_name: 'Контакт',
    emergency_contact_phone: '+70000000002',
    emergency_contact_consent: true,
    accepted_disclaimer: true,
    ...over,
  };
}

let ipSeq = 0;
/** Свой адрес на каждый запрос: предел 5 в минуту на адрес — не предмет этих проверок. */
function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  ipSeq += 1;
  return new NextRequest(`https://vedarai.ru${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${ipSeq}`, ...headers },
    body: JSON.stringify(payload),
  });
}

/** Шрифты настоящего PDF: тот же приём, что в pdf-cyrillic-fonts. */
function baseFonts(pdf: Buffer): string[] {
  return [...pdf.toString('latin1').matchAll(/\/BaseFont\s*\/([A-Za-z0-9+_-]+)/g)].map((x) => x[1]);
}

describe('POST /api/safety/register — одна запись на выход', () => {
  beforeEach(() => {
    m.once.mockReset();
    m.plain.mockReset();
    m.once.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', repeated: false });
  });

  it('без ?pdf включает контроль один раз и отвечает номером записи', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    const res = await POST(post('/api/safety/register', body()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ success: true, registration_id: '11111111-1111-4111-8111-111111111111' });
    expect(m.once).toHaveBeenCalledTimes(1);
    expect(m.plain).not.toHaveBeenCalled();
    expect(m.once.mock.calls[0][0]).toMatchObject({
      source: 'form', routeName: 'Авачинский перевал', leaderPhone: '+70000000000', touristChat: null,
    });
    // Слова ответа — не «зарегистрирован»: регистрирует МЧС.
    expect(String(json.message)).toMatch(/Контроль возвращения включён/);
    expect(String(json.message)).not.toMatch(/зарегистрирован/i);
  });

  it('с ?pdf отдаёт лист и НИЧЕГО не записывает — второй запрос формы не создаёт второй контроль', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    const res = await POST(post('/api/safety/register?pdf=1', body()));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(m.once).not.toHaveBeenCalled();
    expect(m.plain).not.toHaveBeenCalled();
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const fonts = baseFonts(pdf);
    expect(fonts.some((f) => /Helvetica/.test(f))).toBe(false);
    expect(fonts.some((f) => /DejaVuSans/.test(f))).toBe(true);
  });

  it('то же по заголовку Accept: application/pdf', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    const res = await POST(post('/api/safety/register', body(), { accept: 'application/pdf' }));
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(m.once).not.toHaveBeenCalled();
  });

  it('путь формы целиком: сохранить, потом лист — запись одна', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    const payload = body();
    const saved = await POST(post('/api/safety/register', payload));
    const sheet = await POST(post('/api/safety/register?pdf=1', payload));
    expect(saved.status).toBe(200);
    expect(sheet.status).toBe(200);
    expect(m.once).toHaveBeenCalledTimes(1);
  });

  it('база отказала — 503 словами «контроль не включён», а не пустой 500 и не успех', async () => {
    m.once.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57P01' }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('@/app/api/safety/register/route');
    const res = await POST(post('/api/safety/register', body()));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(String(json.error)).toMatch(/не включён/);
    // В лог — код базы, без имён и телефонов.
    const logged = errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toMatch(/57P01/);
    expect(logged).not.toMatch(/\+7000|Тест|Контакт/);
    errors.mockRestore();
  });

  it('имя с «@» вместо chat_id Telegram — 400 с названным полем, а не «сбой на нашей стороне»', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    for (const bad of ['@mama_ivanova', '123 456', '+79990001122', '12345678901234567890']) {
      const res = await POST(post('/api/safety/register', body({ emergency_contact_telegram_chat_id: bad })));
      expect(res.status, bad).toBe(400);
      const json = await res.json();
      expect(String(json.error), bad).toMatch(/Telegram chat_id — только цифры/);
    }
    expect(m.once).not.toHaveBeenCalled();
    // Число, отрицательное число группы и пустое поле — годятся.
    for (const good of ['123456789', '-1001234567890', '']) {
      const res = await POST(post('/api/safety/register', body({ emergency_contact_telegram_chat_id: good })));
      expect(res.status, good).toBe(200);
    }
  });

  it('дата, которой нет в календаре, и состав больше тридцати — 400 до базы', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    const noSuchDay = await POST(post('/api/safety/register', body({ start_date: '2031-02-30', end_date: '2031-03-02' })));
    expect(noSuchDay.status).toBe(400);
    expect(String((await noSuchDay.json()).error)).toMatch(/Такой даты нет/);
    const crowd = Array.from({ length: 31 }, (_, i) => ({ name: `Тест ${i}` }));
    for (const url of ['/api/safety/register', '/api/safety/register?pdf=1']) {
      const res = await POST(post(url, body({ group_members: crowd })));
      expect(res.status, url).toBe(400);
    }
    expect(m.once).not.toHaveBeenCalled();
  });

  it('база не приняла значение поля (класс 22) — 400 «проверьте поля», совета «повторите через минуту» нет', async () => {
    m.once.mockRejectedValueOnce(Object.assign(new Error('invalid input syntax for type bigint: "@mama"'), { code: '22P02' }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('@/app/api/safety/register/route');
    const res = await POST(post('/api/safety/register', body()));
    expect(res.status).toBe(400);
    const text = String((await res.json()).error);
    expect(text).toMatch(/не включён/);
    expect(text).toMatch(/Проверьте даты и числа/);
    expect(text).not.toMatch(/через минуту|на нашей стороне/);
    // Текст ошибки базы несёт введённое значение — в лог идёт только код.
    expect(errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).not.toMatch(/@mama/);
    errors.mockRestore();
  });

  it('нет свободного соединения — 503, и в логе это названо, а не «нет SQLSTATE»', async () => {
    m.once.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('@/app/api/safety/register/route');
    const res = await POST(post('/api/safety/register', body()));
    expect(res.status).toBe(503);
    expect(errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(/нет свободного соединения/);
    errors.mockRestore();
  });

  it('ключ повтора: в запись уходит его SHA-256, а не сам ключ; в ответе и в логе ключа нет', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    const key = '0b7c4f0e-6a55-4f0a-9d53-2a1f6f0f7c11';
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(post('/api/safety/register', body({ submit_key: key })));
    expect(res.status).toBe(200);
    const input = m.once.mock.calls[0][0] as Record<string, unknown>;
    expect(input.submitKeyHash).toBe(createHash('sha256').update(key).digest('hex'));
    expect(JSON.stringify(input)).not.toContain(key);
    expect(JSON.stringify(await res.json())).not.toContain(key);
    expect(logs.mock.calls.flat().map(String).join(' ')).not.toContain(key);
    logs.mockRestore();
  });

  it('ключа нет (старая форма) — запись без него: повтор узнает только вход в аккаунт', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    expect((await POST(post('/api/safety/register', body()))).status).toBe(200);
    expect((m.once.mock.calls[0][0] as Record<string, unknown>).submitKeyHash).toBeNull();
  });

  it('ключ не по форме — 400 со словами, записи нет; лист ключа не требует', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    for (const bad of ['короткий', 'x'.repeat(65), 'с пробелом внутри ключа', "a'; DROP TABLE route_registrations; --"]) {
      const res = await POST(post('/api/safety/register', body({ submit_key: bad })));
      expect(res.status, bad).toBe(400);
      expect(String((await res.json()).error)).toMatch(/Ключ формы/);
    }
    expect(m.once).not.toHaveBeenCalled();
    const sheet = await POST(post('/api/safety/register?pdf=1', body()));
    expect(sheet.status).toBe(200);
    expect(m.once).not.toHaveBeenCalled();
  });

  it('срок в прошлом — 400 и ни записи, ни листа', async () => {
    const { POST } = await import('@/app/api/safety/register/route');
    const past = body({ start_date: '2026-01-01', end_date: '2026-01-02' });
    for (const url of ['/api/safety/register', '/api/safety/register?pdf=1']) {
      const res = await POST(post(url, past));
      expect(res.status).toBe(400);
    }
    expect(m.once).not.toHaveBeenCalled();
  });
});

describe('отправка формы: контроль и лист — два неравноправных шага', () => {
  const okJson = (extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ success: true, registration_id: 'aaaaaaaa-1111-4111-8111-111111111111', ...extra }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  const pdf = () => new Response(new Blob(['%PDF-']), { status: 200, headers: { 'content-type': 'application/pdf' } });
  const silence = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('оба шага прошли — запись одна (один запрос без ?pdf), лист есть', async () => {
    const { submitTripWatchForm } = await import('@/lib/safety/register-submit');
    const calls: string[] = [];
    const res = await submitTripWatchForm({ a: 1 }, async (url) => { calls.push(url); return calls.length === 1 ? okJson() : pdf(); });
    expect(res).toMatchObject({ ok: true, registrationId: 'aaaaaaaa-1111-4111-8111-111111111111' });
    expect(res.ok && res.sheet).toBeInstanceOf(Blob);
    expect(calls).toEqual(['/api/safety/register', '/api/safety/register?pdf=1']);
  });

  it('связь пропала на запросе листа — контроль включён, экран успеха положен, листа нет', async () => {
    const { submitTripWatchForm } = await import('@/lib/safety/register-submit');
    const spy = silence();
    let n = 0;
    const res = await submitTripWatchForm({}, async () => { n += 1; if (n === 1) return okJson(); throw new TypeError('Failed to fetch'); });
    expect(res).toEqual({ ok: true, registrationId: 'aaaaaaaa-1111-4111-8111-111111111111', sheet: null });
    spy.mockRestore();
  });

  it('сервер не отдал лист (500, 429) — то же: контроль включён, листа нет', async () => {
    const { submitTripWatchForm } = await import('@/lib/safety/register-submit');
    const spy = silence();
    for (const status of [500, 429]) {
      let n = 0;
      const res = await submitTripWatchForm({}, async () => { n += 1; return n === 1 ? okJson() : new Response('нет', { status }); });
      expect(res, String(status)).toMatchObject({ ok: true, sheet: null });
    }
    spy.mockRestore();
  });

  it('ответа на первый запрос нет — «неизвестно», и сказано отправить снова без правок', async () => {
    const { submitTripWatchForm, REGISTER_SUBMIT_TEXT } = await import('@/lib/safety/register-submit');
    const spy = silence();
    let n = 0;
    const res = await submitTripWatchForm({}, async () => { n += 1; throw new TypeError('Failed to fetch'); });
    expect(res).toEqual({ ok: false, error: REGISTER_SUBMIT_TEXT.noAnswer });
    expect(REGISTER_SUBMIT_TEXT.noAnswer).toMatch(/неизвестно/);
    expect(REGISTER_SUBMIT_TEXT.noAnswer).toMatch(/не меняя данных/);
    // За листом без записи не ходим.
    expect(n).toBe(1);
    spy.mockRestore();
  });

  it('сервер отказал словами — показываем его слова; успех без номера записи — не успех', async () => {
    const { submitTripWatchForm, REGISTER_SUBMIT_TEXT } = await import('@/lib/safety/register-submit');
    const spy = silence();
    const refused = await submitTripWatchForm({}, async () =>
      new Response(JSON.stringify({ success: false, error: 'Контроль возвращения не включён: сбой на нашей стороне.' }), { status: 503 }));
    expect(refused).toEqual({ ok: false, error: 'Контроль возвращения не включён: сбой на нашей стороне.' });
    const noId = await submitTripWatchForm({}, async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(noId).toEqual({ ok: false, error: REGISTER_SUBMIT_TEXT.notSaved });
    const html = await submitTripWatchForm({}, async () => new Response('<html>502</html>', { status: 502 }));
    expect(html).toEqual({ ok: false, error: REGISTER_SUBMIT_TEXT.badAnswer });
    spy.mockRestore();
  });

  describe('ключ повтора формы', () => {
    const KEY_RULE = /^[A-Za-z0-9_-]{16,64}$/;
    const bodies = () => {
      const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return sent.length % 2 === 1 ? okJson() : pdf();
      };
      return { sent, fetchImpl };
    };
    /** Хранилище устройства: то же, что localStorage, но в памяти теста. */
    const storage = (initial: Record<string, string> = {}) => {
      const data = new Map(Object.entries(initial));
      return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => { data.set(k, v); },
      };
    };
    afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

    it('ключ едет с запросом, который пишет, и не едет с запросом за листом', async () => {
      const { submitTripWatchForm } = await import('@/lib/safety/register-submit');
      const { sent, fetchImpl } = bodies();
      await submitTripWatchForm({ route_name: 'Авачинский перевал' }, fetchImpl, 'device-key-0000000001');
      expect(sent.map((x) => x.url)).toEqual(['/api/safety/register', '/api/safety/register?pdf=1']);
      expect(sent[0].body).toEqual({ route_name: 'Авачинский перевал', submit_key: 'device-key-0000000001' });
      expect(sent[1].body).toEqual({ route_name: 'Авачинский перевал' });
    });

    it('ключ один на устройство: повтор и новое открытие страницы шлют тот же', async () => {
      const disk = storage();
      vi.stubGlobal('localStorage', disk);
      vi.resetModules();
      const first = await import('@/lib/safety/register-submit');
      const a = bodies();
      await first.submitTripWatchForm({ n: 1 }, a.fetchImpl);
      await first.submitTripWatchForm({ n: 1 }, a.fetchImpl);
      const key = String(a.sent[0].body.submit_key);
      expect(key).toMatch(KEY_RULE);
      expect(first.SUBMIT_KEY.test(key)).toBe(true);
      expect(a.sent[2].body.submit_key).toBe(key);
      expect([...disk.data.values()]).toEqual([key]);

      // Страницу открыли заново: модуль загружен с нуля, ключ читается с устройства.
      vi.resetModules();
      const reopened = await import('@/lib/safety/register-submit');
      const b = bodies();
      await reopened.submitTripWatchForm({ n: 1 }, b.fetchImpl);
      expect(b.sent[0].body.submit_key).toBe(key);
    });

    it('хранилище закрыто — ключ живёт в памяти страницы: повтор без перезагрузки узнаётся', async () => {
      const silent = silence();
      vi.stubGlobal('localStorage', {
        getItem: () => { throw new DOMException('denied', 'SecurityError'); },
        setItem: () => { throw new DOMException('denied', 'SecurityError'); },
      });
      vi.resetModules();
      const mod = await import('@/lib/safety/register-submit');
      const { sent, fetchImpl } = bodies();
      await mod.submitTripWatchForm({}, fetchImpl);
      await mod.submitTripWatchForm({}, fetchImpl);
      expect(String(sent[0].body.submit_key)).toMatch(KEY_RULE);
      expect(sent[2].body.submit_key).toBe(sent[0].body.submit_key);
      // Отказ хранилища не проглочен молча — ни при чтении, ни при записи.
      const said = silent.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(said).toMatch(/ключ повтора не прочитан с устройства/);
      expect(said).toMatch(/ключ повтора не сохранён на устройстве/);
      // В лог идёт род отказа, не сам ключ.
      expect(said).not.toContain(String(sent[0].body.submit_key));
      silent.mockRestore();
    });

    it('на устройстве лежит мусор вместо ключа — он не шлётся, создаётся новый', async () => {
      const disk = storage({ 'vedar:trip-watch-submit-key': '<script>' });
      vi.stubGlobal('localStorage', disk);
      vi.resetModules();
      const mod = await import('@/lib/safety/register-submit');
      const { sent, fetchImpl } = bodies();
      await mod.submitTripWatchForm({}, fetchImpl);
      expect(String(sent[0].body.submit_key)).toMatch(KEY_RULE);
      expect(sent[0].body.submit_key).not.toBe('<script>');
    });

    it('случайного источника нет — ключа нет: предсказуемый ключ хуже никакого, форма уходит без него', async () => {
      vi.stubGlobal('localStorage', storage());
      vi.stubGlobal('crypto', undefined);
      vi.resetModules();
      const mod = await import('@/lib/safety/register-submit');
      expect(mod.tripWatchSubmitKey()).toBeNull();
      const { sent, fetchImpl } = bodies();
      const res = await mod.submitTripWatchForm({ n: 1 }, fetchImpl);
      expect(res.ok).toBe(true);
      expect(sent[0].body).toEqual({ n: 1 });
    });
  });

  it('адрес формы с карточки маршрута читается формой: параметр name, не длиннее 200', async () => {
    const { registerFormHref } = await import('@/lib/safety/register-submit');
    const href = registerFormHref('  Вулкан Горелый (кальдера) ');
    expect(href.startsWith('/register?')).toBe(true);
    // Форма читает ровно этот параметр (app/register/page.tsx: q.get('name')).
    expect(new URLSearchParams(href.split('?')[1]).get('name')).toBe('Вулкан Горелый (кальдера)');
    expect(new URLSearchParams(registerFormHref('я'.repeat(500)).split('?')[1]).get('name')).toHaveLength(200);
    expect(registerFormHref('   ')).toBe('/register');
    expect(code('app/register/page.tsx')).toMatch(/q\.get\('name'\)/);
  });
});

describe('лист с данными группы — один генератор, русский шрифт', () => {
  it('строится с кириллическим шрифтом и называет себя «не бланк МЧС»', async () => {
    const mod = await import('@/lib/pdf/mchs-statement');
    const pdf = await mod.generateMchsStatementPDF({
      id: '11111111-1111-4111-8111-111111111111',
      routeName: 'Авачинский перевал',
      region: 'Камчатский край',
      startDate: '2026-11-20',
      endDate: new Date(2026, 10, 21),
      leaderName: 'Тест',
      leaderPhone: '+70000000000',
      groupSize: 2,
      members: mod.statementMembers('[{"name":"Тест Второй","birth_year":1990},{"name":""},7]'),
      contactName: 'Контакт',
      contactPhone: '+70000000002',
    });
    const fonts = baseFonts(pdf);
    expect(fonts.some((f) => /Helvetica/.test(f))).toBe(false);
    expect(fonts.some((f) => /DejaVuSans/.test(f))).toBe(true);
    expect(mod.MCHS_STATEMENT_TITLE).not.toMatch(/заявлени/i);
    expect(mod.MCHS_STATEMENT_NOT_A_FORM).toMatch(/не бланк МЧС/);
    expect(mod.MCHS_STATEMENT_ALSO_ASKED).toMatch(/Впишите в заявку сами/);
    // Не «МЧС спрашивает»: перечень — из памятки ГУ о маршрутном листе.
    expect(mod.MCHS_STATEMENT_ALSO_ASKED).toContain('Памятка ГУ МЧС по краю просит указать в маршрутном листе');
    // Номер записи целиком на лист не попадает: вместе с телефоном он — ключ отметок.
    // Метаданные PDF не сжаты; текст страниц сжат, поэтому проверяется исходник.
    expect(code('lib/pdf/mchs-statement.ts')).not.toMatch(/\$\{data\.id\}/);
  });

  it('«чего в листе нет» — тот же перечень, что у «Скопировать данные», без того, что в листе есть', async () => {
    const mod = await import('@/lib/pdf/mchs-statement');
    const { MCHS_NOT_IN_RECORD } = await import('@/lib/safety/mchs-form-text');
    const missing = mod.statementMissing();
    for (const item of MCHS_NOT_IN_RECORD) expect(missing).toContain(item);
    // Экстренный контакт в записи один, памятка просит двух — названо первым.
    expect(missing[0]).toMatch(/второе контактное лицо.*нужно 2, в листе одно/);
    // ФИО и телефоны участников в листе есть: под «чего нет» они не печатаются.
    expect(missing.join(' | ')).not.toMatch(/ФИО|точное число людей/);
  });

  it('подвал листа: кто подаёт, срок, способы — и что после возвращения в МЧС сообщает сам человек', async () => {
    const mod = await import('@/lib/pdf/mchs-statement');
    const { MCHS_AFTER_RETURN, MCHS_RETURN_NOT_VIA_VEDAR, MCHS_DEADLINE_SHORT } = await import('@/lib/safety/mchs-registration');
    const footer = mod.statementFooter();
    expect(footer).toContain(mod.MCHS_STATEMENT_NOT_A_FORM);
    expect(footer).toContain(MCHS_DEADLINE_SHORT);
    expect(footer).toContain(MCHS_AFTER_RETURN);
    expect(footer).toContain(MCHS_RETURN_NOT_VIA_VEDAR);
    expect(footer).not.toMatch(/Госуслуг|зарегистрирован/i);
  });

  it('даты — без игры поясов; мусор в составе группы — пустой список, а не падение', async () => {
    const mod = await import('@/lib/pdf/mchs-statement');
    expect(mod.statementDate('2026-11-20')).toBe('20.11.2026');
    expect(mod.statementDate(new Date(2026, 10, 21))).toBe('21.11.2026');
    expect(mod.statementDate('когда-нибудь')).toBe('—');
    expect(mod.statementMembers(null)).toEqual([]);
    expect(mod.statementMembers({ name: 'не массив' })).toEqual([]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(mod.statementMembers('{битый json')).toEqual([]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    expect(mod.statementMembers([{ name: ' Тест ', phone: ' ', birth_year: 1990 }])).toEqual([
      { name: 'Тест', phone: null, birth_year: 1990 },
    ]);
  });

  it('способы подачи — из модуля фактов: сайт, почта, лично; Госуслуг нет', async () => {
    const mod = await import('@/lib/pdf/mchs-statement');
    const line = mod.statementChannelsLine();
    expect(line).toMatch(/forms\.mchs\.gov\.ru/);
    expect(line).toMatch(/почтой/);
    expect(line).toMatch(/лично/);
    expect(line).not.toMatch(/Госуслуг/i);
  });
});

/** Все исходники под каталогом. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

/** Текст без комментариев: история «как было» живёт в них и запретом не судится. */
function code(rel: string): string {
  return read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('запреты: слова и вторые двери', () => {
  const SCREENS = [
    ...sources('app/register'),
    ...sources('app/api/safety/register'),
    ...sources('app/return'),
    'app/hub/tourist/safety/_SafetyClient.tsx',
    'lib/pdf/mchs-statement.ts',
    'lib/safety/register-submit.ts',
    'components/safety/MchsRegistrationBlock.tsx',
    // Рамка «Я вернулся» и телефоны экрана успеха живут в своих файлах: фраза
    // «мы напомним» стояла именно в этой рамке, пока она была частью страницы.
    'components/safety/TripWatchReturnBox.tsx',
    'components/safety/MchsConsultPhones.tsx',
  ];

  it('экраны формы и лист не говорят «зарегистрирован», «мы напомним», «Госуслуги», «PDF-заявка скачана»', () => {
    expect(SCREENS.length).toBeGreaterThan(4);
    expect(SCREENS).toEqual(expect.arrayContaining([
      'app/register/page.tsx', 'app/return/ReturnClient.tsx', 'components/safety/TripWatchReturnBox.tsx',
    ]));
    for (const rel of SCREENS) {
      const src = code(rel);
      expect(src, rel).not.toMatch(/(Маршрут|Группа) зарегистрирован/);
      expect(src, rel).not.toMatch(/мы напомним/);
      expect(src, rel).not.toMatch(/Госуслуг/);
      expect(src, rel).not.toMatch(/PDF-заявка скачана/);
      // Сторож МЧС не вызывает: третья ступень — дежурному, решение за ним.
      expect(src, rel).not.toMatch(/тревогу по вашему экстренному контакту и МЧС/);
      expect(src, rel).not.toMatch(/Зарегистрировать маршрут|зарегистрированный маршрут/);
    }
  });

  it('PDF вне lib/pdf не собирают: шрифт без кириллицы уже выходил так в роутах', () => {
    const outside = [...sources('app'), ...sources('components'), ...sources('lib').filter((rel) => !rel.startsWith('lib/pdf/'))];
    expect(outside.length).toBeGreaterThan(500);
    for (const rel of outside) {
      expect(code(rel), rel).not.toMatch(/from ['"]pdfkit['"]|require\(['"]pdfkit['"]\)|new PDFDocument\(/);
    }
  });

  it('запись контроля с формы — только через createTripWatchOnce', () => {
    const route = code('app/api/safety/register/route.ts');
    expect(route).not.toMatch(/createTripWatch\(/);
    // Страница сама к адресу не ходит: два шага и их исходы — в одном месте.
    expect(code('app/register/page.tsx')).not.toMatch(/fetch\(['"`]\/api\/safety\/register/);
  });
});

describe('перепись двойников — счёт без имён', () => {
  it('окно: умолчание, границы, мусор — отказ, а не умолчание молча', async () => {
    const t = await import('@/lib/safety/trip-watch-twins');
    expect(t.twinWindowSeconds(null)).toBe(t.TWIN_WINDOW_SECONDS_DEFAULT);
    expect(t.twinWindowSeconds('')).toBe(t.TWIN_WINDOW_SECONDS_DEFAULT);
    expect(t.twinWindowSeconds('1')).toBe(1);
    expect(t.twinWindowSeconds('3600')).toBe(3600);
    expect(t.twinWindowSeconds('0')).toBeNull();
    expect(t.twinWindowSeconds('3601')).toBeNull();
    expect(t.twinWindowSeconds('12abc')).toBeNull();
    expect(t.twinWindowSeconds('-5')).toBeNull();
  });

  it('нет строки или число не число — «не смог посчитать», а не «двойников нет»', async () => {
    const t = await import('@/lib/safety/trip-watch-twins');
    expect(t.twinsReportFromRow(undefined)).toBeNull();
    const row = {
      form_total: 10, form_open: 4, pairs: 3, twin_rows: 3, twin_identical: 2, twin_identical_open: 1,
      first_open_twin_closed: 0, twin_open: 2,
      twin_open_first_closed: 1, twin_open_first_returned: 1, twin_open_overdue: 1, twin_alerted: 1,
      first_twin_day: '2026-10-02', last_twin_day: '2026-11-08',
    };
    expect(t.twinsReportFromRow({ ...row, twin_open: '2' })).toBeNull();
    expect(t.twinsReportFromRow({ ...row, pairs: undefined })).toBeNull();
    const report = t.twinsReportFromRow(row);
    expect(report).toMatchObject({ twin_rows: 3, twin_open: 2, first_twin_day: '2026-10-02' });
    expect(t.twinsReportFromRow({ ...row, first_twin_day: 'вчера' })?.first_twin_day).toBeNull();
  });

  it('вердикт словами: нет записей, нет двойников, есть двойники', async () => {
    const t = await import('@/lib/safety/trip-watch-twins');
    const zero = {
      form_total: 0, form_open: 0, pairs: 0, twin_rows: 0, twin_identical: 0, twin_identical_open: 0,
      first_open_twin_closed: 0, twin_open: 0,
      twin_open_first_closed: 0, twin_open_first_returned: 0, twin_open_overdue: 0, twin_alerted: 0,
      first_twin_day: null, last_twin_day: null,
    };
    expect(t.twinsVerdict(zero)).toMatch(/Записей с формы нет/);
    expect(t.twinsVerdict({ ...zero, form_total: 7 })).toMatch(/Двойников нет: записей с формы 7/);
    const some = t.twinsVerdict({
      ...zero, form_total: 7, twin_rows: 2, twin_identical: 1, twin_identical_open: 1, twin_open: 1,
      twin_open_first_closed: 1, twin_alerted: 1,
    });
    expect(some).toMatch(/Двойников 2 на 7 записей с формы/);
    expect(some).toMatch(/слово в слово — 1, из них открытых 1/);
    expect(some).toMatch(/открытых — 1/);
  });

  describe('роут переписи — вызовом', () => {
    const ROW = {
      form_total: 12, form_open: 5, pairs: 2, twin_rows: 2, twin_identical: 1, twin_identical_open: 1,
      first_open_twin_closed: 0, twin_open: 1, twin_open_first_closed: 1, twin_open_first_returned: 1,
      twin_open_overdue: 1, twin_alerted: 0, first_twin_day: '2026-10-02', last_twin_day: '2026-11-08',
    };
    const get = (url: string, secret?: string) => new NextRequest(`https://vedarai.ru${url}`, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
    beforeEach(() => {
      m.poolQuery.mockReset();
      process.env.CRON_SECRET = 'probe-secret-for-test';
    });

    it('без секрета и с чужим секретом — 401, база не тронута', async () => {
      const { GET } = await import('@/app/api/cron/trip-watch-twins-census/route');
      expect((await GET(get('/api/cron/trip-watch-twins-census'))).status).toBe(401);
      expect((await GET(get('/api/cron/trip-watch-twins-census', 'wrong-secret'))).status).toBe(401);
      expect(m.poolQuery).not.toHaveBeenCalled();
    });

    it('мусорное окно — 400, база не тронута', async () => {
      const { GET } = await import('@/app/api/cron/trip-watch-twins-census/route');
      for (const w of ['abc', '0', '99999']) {
        const res = await GET(get(`/api/cron/trip-watch-twins-census?window=${w}`, 'probe-secret-for-test'));
        expect(res.status, w).toBe(400);
      }
      expect(m.poolQuery).not.toHaveBeenCalled();
    });

    it('успех: наружу только счётчики и два дня — ни номеров записей, ни имён, ни телефонов', async () => {
      // База отдала лишнее (как если бы запрос расширили): в ответ оно не попадает.
      m.poolQuery.mockResolvedValueOnce({ rows: [{ ...ROW, twin_id: '11111111-1111-4111-8111-111111111111', leader_phone: '+70000000000' }] });
      const { GET } = await import('@/app/api/cron/trip-watch-twins-census/route');
      const res = await GET(get('/api/cron/trip-watch-twins-census?window=300', 'probe-secret-for-test'));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Object.keys(json).sort()).toEqual([
        'collected_at', 'first_open_twin_closed', 'first_twin_day', 'form_open', 'form_total', 'last_twin_day',
        'ok', 'pairs', 'probe', 'twin_alerted', 'twin_identical', 'twin_identical_open', 'twin_open',
        'twin_open_first_closed', 'twin_open_first_returned', 'twin_open_overdue', 'twin_rows', 'verdict', 'window_seconds',
      ]);
      expect(json).toMatchObject({ ok: true, window_seconds: 300, twin_rows: 2, twin_identical_open: 1 });
      expect(JSON.stringify(json)).not.toMatch(/11111111-1111|\+7000/);
      // Окно ушло в запрос параметром, а не строкой в SQL.
      expect(m.poolQuery.mock.calls[0][1][0]).toBe(300);
    });

    it('база отказала или ответ не разобран — 500 и ok:false, а не «двойников нет»', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { GET } = await import('@/app/api/cron/trip-watch-twins-census/route');
      m.poolQuery.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }));
      const failed = await GET(get('/api/cron/trip-watch-twins-census', 'probe-secret-for-test'));
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ ok: false, sqlstate: '57014' });
      for (const rows of [[], [{ ...ROW, twin_open: 'два' }]]) {
        m.poolQuery.mockResolvedValueOnce({ rows });
        const res = await GET(get('/api/cron/trip-watch-twins-census', 'probe-secret-for-test'));
        expect(res.status).toBe(500);
        expect((await res.json()).ok).toBe(false);
      }
      errors.mockRestore();
    });

    it('перепись ничего не пишет', () => {
      expect(code('app/api/cron/trip-watch-twins-census/route.ts')).not.toMatch(/INSERT|UPDATE|DELETE/);
      expect(code('lib/safety/trip-watch-twins.ts')).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/);
    });
  });
});
