/**
 * Гид сам создаёт свой тур и сам выводит его на сайт (слово владельца 31.10:
 * «а должен»; публикация — кнопкой гида, если тур проходит витринный гейт).
 *
 * Судится поведением:
 *  - фраза «новый тур: …» — разбор правилами на граничных фразах: что
 *    создание, что нет (уходит дальше), чего не хватает, что подсказка;
 *  - фраза заводит только черновик создания: в `operator_tours` без кнопки не
 *    пишется ничего; «Создать черновик» зовёт ОБЩУЮ функцию создания с
 *    владельцем — карточкой гида чата; сайт (`POST /api/guide/own/tours`)
 *    зовёт её же, с карточкой вошедшего гида;
 *  - «Опубликовать» / «Снять с сайта» в чате и на сайте — одна функция
 *    `setOwnTourOnSite` с владельцем; отказ гейта на сайте — 409 с перечнем;
 *  - раздел «Свои туры» — рендером: «Новый тур» открывает форму, кнопка не
 *    шлёт неполное и говорит, чего не хватает; черновик с пробелом гейта
 *    называет его и кнопки «Опубликовать» не даёт; тур на сайте — «Снять»;
 *  - помощник-модель знает, что туры сам не создаёт и не публикует.
 * Путь записи и гейт на настоящей базе — tests/integration/chat-cabinet.pg.test.ts
 * («новый тур гида и его витрина») и public-tour-gate.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  create: vi.fn(),
  onSite: vi.fn(),
  gate: vi.fn(),
  write: vi.fn(),
}));

vi.mock('@/lib/config', async (orig) => ({ ...(await orig<typeof import('@/lib/config')>()), getPublicBaseUrl: () => 'https://vedarai.ru' }));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []), release: () => undefined }),
  },
}));
vi.mock('@/lib/database', () => ({
  transaction: async (fn: (c: { query: typeof h.query }) => unknown) => fn({ query: h.query }),
  query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []),
}));
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: vi.fn() }));
vi.mock('@/lib/guides/own-tour-create', async (orig) => {
  const real = await orig<typeof import('@/lib/guides/own-tour-create')>();
  return { ...real, createOwnTourDraft: h.create };
});
vi.mock('@/lib/guides/own-tour-publish', async (orig) => {
  const real = await orig<typeof import('@/lib/guides/own-tour-publish')>();
  return { ...real, setOwnTourOnSite: h.onSite, readPublishGate: h.gate };
});
vi.mock('@/lib/tours/tour-write', async (orig) => {
  const real = await orig<typeof import('@/lib/tours/tour-write')>();
  return { ...real, writeTourPatch: h.write };
});
vi.mock('@/lib/auth/middleware', () => ({ requireRole: vi.fn(async () => ({ userId: 'user-guide', role: 'guide' })) }));
vi.mock('@/lib/auth/guide-helpers', () => ({ getGuidePartnerId: vi.fn(async () => 'guide-partner') }));

const { parseTourCreate, parseCreateCaption } = await import('@/lib/guides/tour-edit/create-parse');
const { captureGuideTourEdit, guideTourPress } = await import('@/lib/guides/tour-edit/flow');
const { parseCabinetPress, cabinetPayload, CABINET_PAYLOAD_MAX_BYTES } = await import('@/lib/chat-cabinet/payload');
const { partnerSystemPrompt } = await import('@/lib/kuzmich/operator-chat');
const { POST: createRoute } = await import('@/app/api/guide/own/tours/route');
const { POST: publishRoute } = await import('@/app/api/guide/own/tours/[id]/publish/route');
const { PATCH: editRoute } = await import('@/app/api/guide/own/tours/[id]/route');
const { OwnToursManager } = await import('@/components/guide/OwnToursManager');

const DRAFT = 'abcdabcd-0000-4000-8000-0000000000c1';
const GUIDE = {
  partnerId: '12121212-1212-4121-8121-121212121212',
  partnerName: 'Гид',
  slug: null,
  category: 'guide',
  crmCategory: 'guide' as const,
  userId: '34343434-3434-4343-8343-343434343434',
  sellsTours: false,
};
const WHO = { partner: GUIDE, owner: true, channel: 'max' as const, chatId: 501, nowMs: Date.UTC(2026, 9, 31) };

const PHRASE = 'новый тур: Восхождение на Горелый; цена 15 000; группа 4; описание: Подъём на вулкан.\nКратер; кислотное озеро.';

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.query.mockResolvedValue({ rows: [], rowCount: 0 });
  h.gate.mockResolvedValue({ outcome: 'ok', onStorefront: false, blockers: [] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => cleanup());

describe('разбор фразы «новый тур»', () => {
  it('название, цена, группа, описание с абзацами и «;» — вход общей функции; единица — за человека', () => {
    expect(parseTourCreate(PHRASE)).toEqual({
      kind: 'ok',
      values: {
        title: 'Восхождение на Горелый', base_price: 15000, price_unit: 'per_person', max_participants: 4,
        description: 'Подъём на вулкан.\nКратер; кислотное озеро.',
      },
    });
  });

  it('«за группу», «до 6 человек», группа раньше цены, с новой строки — так же', () => {
    expect(parseTourCreate('Новый тур: Авачинский перевал\nгруппа до 6 человек\nцена 60000 за группу\nописание: Прогулка.')).toMatchObject({
      kind: 'ok', values: { title: 'Авачинский перевал', base_price: 60000, price_unit: 'per_tour', max_participants: 6 },
    });
    expect(parseTourCreate('новый тур: Авачинский перевал; до 6 человек; цена 6000 с человека; описание: x')).toMatchObject({
      kind: 'ok', values: { max_participants: 6, price_unit: 'per_person' },
    });
  });

  it('чего нет — названо, не угадано; цена не числом и лишняя часть — с причиной', () => {
    expect(parseTourCreate('новый тур: Вачкажец и озёрки; описание: Горный массив.')).toMatchObject({
      kind: 'incomplete', missing: ['base_price', 'max_participants'],
    });
    const bad = parseTourCreate('новый тур: Вачкажец и озёрки; цена дорого; группа 4; погода хорошая; описание: x');
    expect(bad).toMatchObject({ kind: 'incomplete', missing: ['base_price'] });
    expect(bad?.kind === 'incomplete' && bad.problems.join(' ')).toMatch(/Цена — одним числом/);
    expect(bad?.kind === 'incomplete' && bad.problems.join(' ')).toMatch(/Не понял часть «погода хорошая»/);
    expect(parseTourCreate('новый тур: Тур; цена 15000; группа 4; описание: x')).toMatchObject({ kind: 'incomplete', missing: ['title'] });
    expect(parseTourCreate('новый тур: Вачкажец; цена 15000; группа 0; описание: x')).toMatchObject({ kind: 'incomplete', missing: ['max_participants'] });
  });

  it('«новый тур» без полей — подсказка; другие фразы — не создание', () => {
    expect(parseTourCreate('новый тур')).toEqual({ kind: 'hint' });
    expect(parseTourCreate('Новый тур:')).toEqual({ kind: 'hint' });
    expect(parseTourCreate('Горелый: описание: новый тур по кратеру')).toBeNull();
    expect(parseTourCreate('новый туризм: x')).toBeNull();
    expect(parseTourCreate('новый тур на Горелый будет?')).toBeNull();
  });

  it('подпись к документу: цена и группа — нового тура; поиск своего тура — по остальным словам', () => {
    expect(parseCreateCaption('цена 15000; группа 4')).toEqual({
      specs: { base_price: 15000, max_participants: 4 }, problems: [], tourWords: null,
    });
    expect(parseCreateCaption('Горелый, цена 15000, группа 4')).toMatchObject({ specs: { title: 'Горелый' }, tourWords: 'Горелый' });
    // Подпись без цены и группы — как до 31.10: целиком слова тура.
    expect(parseCreateCaption('Курильское озеро, 3 дня').tourWords).toBe('Курильское озеро, 3 дня');
  });
});

describe('кнопки нового тура и витрины', () => {
  it('разбираются обратно и влезают в 64 байта; испорченные — не кнопки', () => {
    for (const [p, want] of [
      [cabinetPayload.tourNew(), { kind: 'tour_new' }],
      [cabinetPayload.createSave(DRAFT), { kind: 'create_save', draftId: DRAFT }],
      [cabinetPayload.createCancel(DRAFT), { kind: 'create_cancel', draftId: DRAFT }],
      [cabinetPayload.tourPublish('123456789012345678'), { kind: 'tour_publish', tourId: '123456789012345678' }],
      [cabinetPayload.tourUnpublish('77'), { kind: 'tour_unpublish', tourId: '77' }],
    ] as const) {
      expect(parseCabinetPress(p), p).toEqual(want);
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(CABINET_PAYLOAD_MAX_BYTES);
    }
    for (const bad of ['cb:u:n:1', 'cb:u:p:', 'cb:u:x:77', `cb:e:q:${DRAFT}`, 'cb:e:c:1']) expect(parseCabinetPress(bad), bad).toBeNull();
  });
});

describe('чат: создаёт только кнопка, и только общей функцией', () => {
  function sqlOf(): string[] {
    return h.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
  }

  it('фраза — предпросмотр и черновик создания; в operator_tours ничего', async () => {
    h.query.mockImplementation(async (sql: string) => (/INSERT INTO tour_create_drafts/.test(sql) ? { rows: [{ id: DRAFT }] } : { rows: [], rowCount: 0 }));
    const shown = await captureGuideTourEdit({ channel: 'max', chatId: 501, partner: GUIDE, text: PHRASE });
    expect(shown?.text).toContain('<b>Новый тур — черновик</b>');
    expect(shown?.text).toContain('Ничего не создано, пока вы не нажмёте «Создать черновик»');
    expect(shown?.rows.flat()).toContainEqual(expect.objectContaining({ text: 'Создать черновик', payload: cabinetPayload.createSave(DRAFT) }));
    expect(sqlOf().some((s) => /operator_tours/.test(s))).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
    // Прежние черновики этого чата сняты в той же транзакции.
    for (const t of ['tour_chat_edits', 'tour_doc_drafts', 'guide_chat_drafts', 'tour_create_drafts']) {
      expect(sqlOf().some((s) => s.startsWith(`UPDATE ${t} SET status = 'superseded'`)), t).toBe(true);
    }
  });

  it('не гид — «новый тур» не его дверь: фраза идёт дальше', async () => {
    expect(await captureGuideTourEdit({ channel: 'max', chatId: 501, partner: { ...GUIDE, category: 'operator' }, text: PHRASE })).toBeNull();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('«Создать черновик» зовёт общую функцию с карточкой гида чата и его аккаунтом', async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (/FROM tour_create_drafts/.test(sql)) {
        return { rows: [{ id: DRAFT, status: 'pending', expired: false, tour_id: null, draft_values: {
          title: 'Восхождение на Горелый', base_price: 15000, price_unit: 'per_person', max_participants: 4, description: 'Подъём.',
        } }] };
      }
      return { rows: [], rowCount: 1 };
    });
    h.create.mockResolvedValue({ outcome: 'created', tour: { id: '901', title: 'Восхождение на Горелый', slug: null } });
    const out = await guideTourPress({ kind: 'create_save', draftId: DRAFT }, WHO);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]![1]).toMatchObject({
      ownerId: GUIDE.partnerId, userId: GUIDE.userId, input: { title: 'Восхождение на Горелый', max_participants: 4 },
    });
    expect(out.text).toMatch(/^Создан черновик тура «Восхождение на Горелый»/);
    expect(sqlOf().some((s) => /UPDATE tour_create_drafts SET status = 'created', tour_id = \$2::bigint/.test(s))).toBe(true);
  });

  it('менеджер команды и чужая роль кнопкой не создают и не публикуют', async () => {
    expect((await guideTourPress({ kind: 'create_save', draftId: DRAFT }, { ...WHO, owner: false })).text).toMatch(/Ничего не записал/);
    expect((await guideTourPress({ kind: 'tour_publish', tourId: '77' }, { ...WHO, partner: { ...GUIDE, category: 'operator', sellsTours: true } })).text)
      .toMatch(/Ничего не записал/);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.onSite).not.toHaveBeenCalled();
  });

  it('«Опубликовать» и «Снять с сайта» — общей функцией с карточкой гида; отказ гейта назван', async () => {
    const seller = { ...WHO, partner: { ...GUIDE, sellsTours: true } };
    h.onSite.mockResolvedValue({ outcome: 'blocked', title: 'Бухта Русская', blockers: ['description'] });
    h.query.mockResolvedValue({ rows: [{
      id: '77', title: 'Бухта Русская', slug: null, is_active: true, is_published: false, base_price: '19000', price_unit: 'per_person',
      max_participants: 4, short_description: null, description: null, program: null, included: null, not_included: null,
      what_to_bring: null, safety_notes: null,
    }] });
    h.gate.mockResolvedValue({ outcome: 'ok', onStorefront: false, blockers: ['description'] });
    const refused = await guideTourPress({ kind: 'tour_publish', tourId: '77' }, seller);
    expect(h.onSite).toHaveBeenCalledWith({ ownerId: GUIDE.partnerId, tourId: '77', publish: true });
    expect(refused.text).toMatch(/Не опубликовал «Бухта Русская»: тур остался черновиком/);
    expect(refused.text).toContain('• нет описания тура');
    expect(refused.rows.flat().some((b) => b.text === 'Опубликовать')).toBe(false);
    h.onSite.mockResolvedValue({ outcome: 'unpublished', title: 'Бухта Русская' });
    await guideTourPress({ kind: 'tour_unpublish', tourId: '77' }, seller);
    expect(h.onSite).toHaveBeenLastCalledWith({ ownerId: GUIDE.partnerId, tourId: '77', publish: false });
  });

  it('гейт не прочитался — экран тура так и говорит, а не «всего хватает»', async () => {
    h.query.mockResolvedValue({ rows: [{
      id: '77', title: 'Бухта Русская', slug: null, is_active: true, is_published: false, base_price: '19000', price_unit: 'per_person',
      max_participants: 4, short_description: null, description: 'Есть.', program: null, included: null, not_included: null,
      what_to_bring: null, safety_notes: null,
    }] });
    h.gate.mockResolvedValue({ outcome: 'db_error' });
    const out = await guideTourPress({ kind: 'tour', tourId: '77' }, { ...WHO, partner: { ...GUIDE, sellsTours: true } });
    expect(out.text).toMatch(/Чего не хватает до сайта — не проверилось/);
    expect(out.text).not.toMatch(/всего хватает/);
  });

  it('помощник-модель: туры сам не создаёт и не публикует — и у гида без своих туров', () => {
    for (const sellsTours of [false, true]) {
      const p = partnerSystemPrompt({ ...GUIDE, sellsTours }, Date.UTC(2026, 9, 31), true);
      expect(p).toMatch(/Туры ты сам не создаёшь и не публикуешь и не говоришь, что создал, опубликовал или снял тур с сайта/);
      expect(p).toMatch(/создаёт только она/);
    }
  });
});

describe('сайт: двери раздела «Свои туры» — те же общие функции', () => {
  it('POST /api/guide/own/tours — общая функция с карточкой вошедшего гида; неполное — 400 без записи', async () => {
    h.create.mockResolvedValue({ outcome: 'created', tour: { id: '902', title: 'Тур на Авачу', slug: null } });
    h.gate.mockResolvedValue({ outcome: 'ok', onStorefront: false, blockers: [] });
    const body = { title: 'Тур на Авачу', base_price: 9000, price_unit: 'per_person', max_participants: 6, description: 'Восхождение.' };
    const res = await createRoute(new NextRequest('https://vedarai.ru/api/guide/own/tours', { method: 'POST', body: JSON.stringify(body) }));
    expect(res.status).toBe(201);
    expect(h.create.mock.calls[0]![1]).toMatchObject({ ownerId: 'guide-partner', userId: 'user-guide', input: body });
    expect(await res.json()).toMatchObject({ success: true, data: { id: '902', blockers: [] } });
    const bad = await createRoute(new NextRequest('https://vedarai.ru/api/guide/own/tours', {
      method: 'POST', body: JSON.stringify({ title: 'Тур на Авачу', base_price: 9000, description: 'x' }),
    }));
    expect(bad.status).toBe(400);
    // Публиковать через создание нельзя: лишнее поле схема не пропускает.
    const sneaky = await createRoute(new NextRequest('https://vedarai.ru/api/guide/own/tours', {
      method: 'POST', body: JSON.stringify({ ...body, is_published: true }),
    }));
    expect(sneaky.status).toBe(400);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('POST …/publish — общая функция с карточкой вошедшего; гейт не пройден — 409 и перечень словами', async () => {
    h.onSite.mockResolvedValue({ outcome: 'blocked', title: 'Бухта Русская', blockers: ['description', 'guide_not_public'] });
    const res = await publishRoute(
      new NextRequest('https://vedarai.ru/api/guide/own/tours/77/publish', { method: 'POST', body: JSON.stringify({ publish: true }) }),
      { params: Promise.resolve({ id: '77' }) },
    );
    expect(h.onSite).toHaveBeenCalledWith({ ownerId: 'guide-partner', tourId: '77', publish: true });
    expect(res.status).toBe(409);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('нет описания тура');
    expect(json.error).toContain('анкету гида ещё не одобрила платформа');
  });

  it('PATCH правки — общая запись тура с владельцем; публикацию и чужие поля не пропускает', async () => {
    h.write.mockResolvedValue({ outcome: 'written', row: { id: '77', title: 'Новое имя тура', updated_at: 'now' } });
    const ok = await editRoute(
      new NextRequest('https://vedarai.ru/api/guide/own/tours/77', { method: 'PATCH', body: JSON.stringify({ title: 'Новое имя тура', base_price: 16000 }) }),
      { params: Promise.resolve({ id: '77' }) },
    );
    expect(ok.status).toBe(200);
    expect(h.write.mock.calls[0]![1]).toMatchObject({ tourId: '77', ownerId: 'guide-partner', input: { title: 'Новое имя тура', base_price: 16000 } });
    const sneaky = await editRoute(
      new NextRequest('https://vedarai.ru/api/guide/own/tours/77', { method: 'PATCH', body: JSON.stringify({ is_published: true }) }),
      { params: Promise.resolve({ id: '77' }) },
    );
    expect(sneaky.status).toBe(400);
    expect(h.write).toHaveBeenCalledTimes(1);
  });
});

describe('раздел «Свои туры»: «Мои туры» рендером', () => {
  const base = {
    slug: null, is_active: true, base_price: '15000', price_unit: 'per_person', max_participants: 4, short_description: null,
    season_start: null, season_end: null, open_dates: 0,
  };
  const ON = { ...base, id: '11', title: 'Горелый', is_published: true, description: 'Есть.', on_storefront: true, blockers: [] as string[] };
  const READY = { ...base, id: '12', title: 'Авача', is_published: false, description: 'Есть.', on_storefront: false, blockers: [] as string[] };
  const GAP = { ...base, id: '13', title: 'Бухта Русская', is_published: false, description: null, on_storefront: false, blockers: ['description'] };
  let calls: Array<{ url: string; method: string; body: unknown }> = [];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ success: true, message: 'готово', data: { id: '99' } }) } as Response;
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('черновик с пробелом — перечень и без «Опубликовать»; готовый — «Опубликовать»; на сайте — ссылка и «Снять с сайта»', async () => {
    const done = vi.fn();
    render(<OwnToursManager tours={[ON, READY, GAP]} onDone={done} />);
    const gap = within(screen.getByTestId('own-tour-13'));
    expect(gap.getByText('нет описания тура')).toBeTruthy();
    expect(gap.queryByRole('button', { name: /Опубликовать/ })).toBeNull();
    expect(gap.getByText('черновик — туристы не видят')).toBeTruthy();
    const on = within(screen.getByTestId('own-tour-11'));
    expect(on.getByRole('link', { name: 'Горелый' }).getAttribute('href')).toBe('/catalog/tours/11');
    fireEvent.click(on.getByRole('button', { name: /Снять с сайта/ }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(calls.at(-1)).toEqual({ url: '/api/guide/own/tours/11/publish', method: 'POST', body: { publish: false } });
    fireEvent.click(within(screen.getByTestId('own-tour-12')).getByRole('button', { name: /Опубликовать/ }));
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ publish: true }));
    expect(calls.at(-1)?.url).toBe('/api/guide/own/tours/12/publish');
  });

  it('«Новый тур»: неполное не уходит и названо; заполненное — POST с четырьмя полями', async () => {
    const done = vi.fn();
    render(<OwnToursManager tours={[]} onDone={done} />);
    expect(screen.getByText('Своих туров пока нет — создайте первый.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Новый тур/ }));
    const form = within(screen.getByRole('form', { name: 'Новый тур' }));
    const submit = form.getByRole('button', { name: /Создать черновик/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId('own-tour-gaps').textContent).toMatch(/название.*цена.*размер группы.*описание/);
    fireEvent.change(form.getByLabelText('Название'), { target: { value: 'Тур на Авачу' } });
    fireEvent.change(form.getByLabelText('Цена, ₽'), { target: { value: '9000' } });
    fireEvent.change(form.getByLabelText('Группа, человек максимум'), { target: { value: '6' } });
    fireEvent.change(form.getByLabelText(/Описание/), { target: { value: 'Восхождение на Авачинский.' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(calls).toEqual([{
      url: '/api/guide/own/tours', method: 'POST',
      body: { title: 'Тур на Авачу', base_price: 9000, price_unit: 'per_person', max_participants: 6, description: 'Восхождение на Авачинский.' },
    }]);
    expect(done.mock.calls[0]![0]).toMatch(/Создан черновик «Тур на Авачу»/);
  });
});
