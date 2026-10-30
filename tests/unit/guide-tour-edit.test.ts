/**
 * Гид правит свой тур из чата кабинета (слово владельца 30.10: «гид должен
 * полностью управлять своей ролью из MAX»). Повод — в тот же день гид правил
 * тексты своих туров в Google-документах: правки текста тура у гида не было
 * нигде.
 *
 * Судится поведением:
 *  - разбор фразы — правилами, вызовом на граничных фразах: что правка, что
 *    нет (уходит помощнику), что отказ с причиной;
 *  - тур — по словам гида среди СВОИХ, неоднозначно — выбор, а не догадка;
 *  - предпросмотр: цена «было → станет», кнопки «Сохранить» / «Отмена»,
 *    введённое человеком экранировано;
 *  - без кнопки в тур не пишется ничего: фраза заводит только черновик;
 *  - сайт и чат пишут тур ОДНОЙ функцией (`writeTourPatch`): PATCH кабинета
 *    оператора и «Сохранить» в чате зовут её, и владелец передаётся в неё;
 *  - помощник-модель знает, что сам тур не правит.
 * Путь записи на настоящей базе — tests/integration/chat-cabinet.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  write: vi.fn(),
  query: vi.fn(),
  getTourById: vi.fn(),
}));

vi.mock('@/lib/tours/tour-write', async (orig) => {
  const real = await orig<typeof import('@/lib/tours/tour-write')>();
  return { ...real, writeTourPatch: h.write };
});
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
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn(async () => ({ userId: 'user-op', role: 'operator' })),
}));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: vi.fn(async () => 'op-partner') }));
vi.mock('@/lib/operators/team-access', () => ({ requireTeamPermission: vi.fn(async () => null) }));
vi.mock('@/lib/operators/team-money', () => ({ changesTourPrice: () => false }));
vi.mock('@/lib/api/operator-tours', async (orig) => {
  const real = await orig<typeof import('@/lib/api/operator-tours')>();
  return { ...real, getTourById: h.getTourById };
});

const { parseTourEdit, pickTour } = await import('@/lib/guides/tour-edit/parse');
const screens = await import('@/lib/guides/tour-edit/screens');
const { captureGuideTourEdit } = await import('@/lib/guides/tour-edit/flow');
const { saveDraft } = await import('@/lib/guides/tour-edit/store');
const { PATCH } = await import('@/app/api/hub/operator/tours/[id]/route');
const { partnerSystemPrompt } = await import('@/lib/kuzmich/operator-chat');
const { parseCabinetPress, cabinetPayload, CABINET_PAYLOAD_MAX_BYTES } = await import('@/lib/chat-cabinet/payload');

const GUIDE = {
  partnerId: '12121212-1212-4121-8121-121212121212',
  partnerName: 'Гид',
  slug: null,
  category: 'guide',
  crmCategory: 'guide' as const,
  userId: '34343434-3434-4343-8343-343434343434',
  sellsTours: true,
};
const DRAFT = 'abcdabcd-0000-4000-8000-000000000001';

function tourRow(over: Record<string, unknown> = {}) {
  return {
    id: '77', title: 'Восхождение на Горелый', slug: 'gorely', is_active: true, is_published: true,
    base_price: '15000.00', price_unit: 'per_person', max_participants: 8, short_description: null,
    description: 'Было.', program: null, included: null, not_included: null, what_to_bring: null, safety_notes: null,
    main_place_id: null, ...over,
  };
}

const flat = (s: string) => s.replace(/ /g, ' ');

beforeEach(() => {
  h.write.mockReset();
  h.query.mockReset();
  h.getTourById.mockReset();
  h.query.mockResolvedValue({ rows: [], rowCount: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('разбор фразы правки', () => {
  it('«Горелый: описание: …» — тур, поле и текст', () => {
    expect(parseTourEdit('Горелый: описание: Восхождение на вулкан.\nВторой абзац.')).toEqual({
      ok: true, edit: { tourWords: 'Горелый', field: 'description', value: 'Восхождение на вулкан.\nВторой абзац.' },
    });
  });

  it('цена: «16000», «16 000 ₽», «16 000 руб» — число; без тура — тур не назван', () => {
    for (const t of ['Горелый: цена 16000', 'Горелый: цена: 16 000 ₽', 'Горелый: стоимость 16 000 руб']) {
      expect(parseTourEdit(t), t).toMatchObject({ ok: true, edit: { tourWords: 'Горелый', field: 'base_price', value: 16000 } });
    }
    expect(parseTourEdit('цена 16000')).toMatchObject({ ok: true, edit: { tourWords: null, field: 'base_price', value: 16000 } });
  });

  it('цена не числом, с копейками или вне пределов — отказ с причиной, а не правка', () => {
    expect(parseTourEdit('Горелый: цена: шестнадцать тысяч')).toMatchObject({ ok: false, reason: 'bad_price' });
    expect(parseTourEdit('Горелый: цена 16000,50')).toMatchObject({ ok: false, reason: 'bad_price' });
    expect(parseTourEdit('Горелый: цена 50')).toMatchObject({ ok: false, reason: 'price_range' });
  });

  it('списки: строки, «;» и запятые; номера и маркеры снимаются; «не входит» — не «входит»', () => {
    expect(parseTourEdit('Толбачик: что взять: ботинки, куртка, перчатки')).toMatchObject({
      ok: true, edit: { field: 'what_to_bring', value: ['ботинки', 'куртка', 'перчатки'] },
    });
    expect(parseTourEdit('Толбачик: не входит:\n- перелёт\n- страховка')).toMatchObject({
      ok: true, edit: { field: 'not_included', value: ['перелёт', 'страховка'] },
    });
    expect(parseTourEdit('Толбачик: входит: 1. трансфер 2. обед')).toMatchObject({
      ok: true, edit: { field: 'included', value: ['трансфер', 'обед'] },
    });
    // В правилах безопасности запятая — часть фразы.
    expect(parseTourEdit('Толбачик: безопасность: на вершине ветер, нужна куртка')).toMatchObject({
      ok: true, edit: { field: 'safety_notes', value: ['на вершине ветер, нужна куртка'] },
    });
  });

  it('программа: шаги с номерами, заголовок до двоеточия, продолжение строки — к тексту шага', () => {
    const r = parseTourEdit('Горелый: программа:\n1. Дорога: выезд в 7:00.\nДорога 3 часа.\n2. Восхождение — 3 часа\n3. Возвращение');
    expect(r).toMatchObject({
      ok: true,
      edit: {
        field: 'program',
        value: [
          { title: 'Дорога', text: 'выезд в 7:00.\nДорога 3 часа.' },
          { title: 'Восхождение', text: '3 часа' },
          { title: 'Возвращение', text: '' },
        ],
      },
    });
  });

  it('шаг без заголовка — отказ: заголовок не выдумывается', () => {
    const long = 'а'.repeat(200);
    expect(parseTourEdit(`Горелый: программа: ${long}`)).toMatchObject({ ok: false, reason: 'step_no_title', index: 1 });
  });

  it('пределы формы кабинета: описание до 4000, название от 5, пусто — отказ', () => {
    // Решение владельца 30.10: описание до 4000 (было 2000) — 2684 знака гида проходят.
    expect(parseTourEdit(`Горелый: описание: ${'я'.repeat(2684)}`)).toMatchObject({ ok: true });
    expect(parseTourEdit(`Горелый: описание: ${'я'.repeat(4001)}`)).toMatchObject({ ok: false, reason: 'too_long', max: 4000 });
    expect(parseTourEdit('Горелый: название: Ой')).toMatchObject({ ok: false, reason: 'too_short' });
    expect(parseTourEdit('Горелый: описание:')).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('пункт безопасности — до 500 знаков, пункт «что взять» — по-прежнему до 200', () => {
    expect(parseTourEdit(`Горелый: безопасность: ${'б'.repeat(500)}`)).toMatchObject({ ok: true });
    expect(parseTourEdit(`Горелый: безопасность: ${'б'.repeat(501)}`)).toMatchObject({ ok: false, reason: 'item_too_long', max: 500 });
    expect(parseTourEdit(`Горелый: что взять: ${'в'.repeat(201)}`)).toMatchObject({ ok: false, reason: 'item_too_long', max: 200 });
  });

  it('не правка — null: разговор, вопрос, задача, команда и «описание» внутри фразы', () => {
    for (const t of [
      'Когда выезд на Горелый?',
      'Анна: перезвонить завтра',
      'описание тура какое?',
      'Горелый — описание надо поправить',
      '/tours',
      'открой субботы июля, 8 мест',
      'Цена тура какая сейчас',
    ]) expect(parseTourEdit(t), t).toBeNull();
  });
});

describe('тур по словам гида — только среди своих', () => {
  const tours = [
    { id: '1', title: 'Восхождение на вулкан Горелый и лавовые пещеры' },
    { id: '2', title: 'Курильское озеро 3 дня' },
    { id: '3', title: 'Курильское озеро 4 дня' },
  ];

  it('слово названия, падеж, номер дня', () => {
    expect(pickTour('Горелый', tours)).toEqual({ kind: 'one', tour: tours[0] });
    expect(pickTour('горелого', tours)).toEqual({ kind: 'one', tour: tours[0] });
    expect(pickTour('Курильское 4 дня', tours)).toEqual({ kind: 'one', tour: tours[2] });
  });

  it('несколько подходят — выбор, а не первый попавшийся; нет такого — «не нашёл»', () => {
    expect(pickTour('Курильское', tours)).toEqual({ kind: 'choose', tours: [tours[1], tours[2]] });
    expect(pickTour('Толбачик', tours)).toEqual({ kind: 'missing' });
  });

  it('тур не назван: один тур — он, несколько — выбор', () => {
    expect(pickTour(null, [tours[0]!])).toEqual({ kind: 'one', tour: tours[0] });
    expect(pickTour(null, tours)).toMatchObject({ kind: 'choose' });
  });
});

describe('кнопки «Моих туров» — payload', () => {
  it('каждая форма разбирается обратно, укладывается в 64 байта и не несёт ничего, кроме номеров', () => {
    const forms: Array<[string, unknown]> = [
      [cabinetPayload.myTours(), { kind: 'my_tours' }],
      [cabinetPayload.tour('123456789012345678'), { kind: 'tour', tourId: '123456789012345678' }],
      [cabinetPayload.tourDates('77', 3), { kind: 'tour_dates', tourId: '77', page: 3 }],
      [cabinetPayload.dateOpen('77', '2026-11-03'), { kind: 'date_open', tourId: '77', date: '2026-11-03' }],
      [cabinetPayload.dateClose('77', '2026-11-03'), { kind: 'date_close', tourId: '77', date: '2026-11-03' }],
      [cabinetPayload.tourHint('77'), { kind: 'tour_hint', tourId: '77' }],
      [cabinetPayload.editSave(DRAFT), { kind: 'edit_save', draftId: DRAFT }],
      [cabinetPayload.editCancel(DRAFT), { kind: 'edit_cancel', draftId: DRAFT }],
      [cabinetPayload.editTour(DRAFT, 7), { kind: 'edit_tour', draftId: DRAFT, index: 7 }],
    ];
    for (const [payload, press] of forms) {
      expect(parseCabinetPress(payload), payload).toEqual(press);
      expect(Buffer.byteLength(payload), payload).toBeLessThanOrEqual(CABINET_PAYLOAD_MAX_BYTES);
    }
    expect(parseCabinetPress('cb:w:77:13')).toBeNull();
    expect(parseCabinetPress('cb:e:t:' + DRAFT + ':8')).toBeNull();
  });
});

describe('предпросмотр', () => {
  const tour = {
    id: '77', title: 'Тур <b>гида</b>', slug: null, isActive: true, isPublished: true, basePrice: 15000,
    priceUnit: 'per_person', maxParticipants: 8,
    fields: { title: 'Тур <b>гида</b>', short_description: null, description: 'Старое', program: null, included: null,
      not_included: null, what_to_bring: null, safety_notes: null, base_price: 15000 },
  };

  it('цена — «было → станет» с единицей; кнопки «Сохранить» и «Отмена» несут только номер черновика', () => {
    const s = screens.previewScreen({ draftId: DRAFT, tour, field: 'base_price', newValue: 16000, liveValue: 15000 });
    expect(flat(s.text)).toContain('Было: 15 000 ₽ за человека');
    expect(flat(s.text)).toContain('Станет: <b>16 000 ₽ за человека</b>');
    expect(s.text).toContain('Ничего не записано, пока вы не нажмёте «Сохранить»');
    expect(s.rows[0]).toEqual([
      { text: 'Сохранить', payload: `cb:e:s:${DRAFT}`, intent: 'positive' },
      { text: 'Отмена', payload: `cb:e:x:${DRAFT}`, intent: 'negative' },
    ]);
    expect(s.pd).toBe(false);
  });

  it('введённое человеком экранировано: название тура и новый текст', () => {
    const s = screens.previewScreen({ draftId: DRAFT, tour, field: 'description', newValue: '<script>x</script>', liveValue: 'Старое' });
    expect(s.text).toContain('Тур &lt;b&gt;гида&lt;/b&gt;');
    expect(s.text).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(s.text).not.toContain('<script>');
  });
});

describe('без кнопки — в тур не пишется ничего', () => {
  it('фраза заводит черновик и показывает предпросмотр; writeTourPatch и UPDATE operator_tours не звучат', async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (/FROM operator_tours t\s+WHERE t\.operator_id/.test(sql)) return { rows: [tourRow()] };
      if (/INSERT INTO tour_chat_edits/.test(sql)) return { rows: [{ id: DRAFT }] };
      return { rows: [], rowCount: 0 };
    });
    const s = await captureGuideTourEdit({ channel: 'max', chatId: 1, partner: GUIDE, text: 'Горелый: цена 16000' });
    expect(flat(s?.text ?? '')).toContain('Станет: <b>16 000 ₽ за человека</b>');
    expect(h.write).not.toHaveBeenCalled();
    expect(h.query.mock.calls.map(([sql]) => String(sql)).filter((q) => /UPDATE operator_tours/.test(q))).toEqual([]);
  });

  it('гид без своих туров и туроператор — фраза не перехватывается (идёт своим путём)', async () => {
    expect(await captureGuideTourEdit({ channel: 'max', chatId: 1, partner: { ...GUIDE, sellsTours: false }, text: 'Горелый: цена 16000' })).toBeNull();
    expect(await captureGuideTourEdit({ channel: 'max', chatId: 1, partner: { ...GUIDE, category: 'operator', crmCategory: 'operator' }, text: 'Горелый: цена 16000' })).toBeNull();
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('сайт и чат пишут тур одной функцией', () => {
  it('PATCH кабинета оператора зовёт writeTourPatch с владельцем — карточкой вошедшего', async () => {
    h.getTourById.mockResolvedValue({ id: '51', operator_id: 'op-partner', base_price: 15000 });
    h.write.mockResolvedValue({ outcome: 'written', row: { id: '51', title: 'Тур', updated_at: 'now' } });
    const res = await PATCH(
      new NextRequest('https://vedarai.ru/api/hub/operator/tours/51', { method: 'PATCH', body: JSON.stringify({ description: 'Новое' }) }),
      { params: Promise.resolve({ id: '51' }) },
    );
    expect(res.status).toBe(200);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write.mock.calls[0]![1]).toMatchObject({ tourId: 51n, ownerId: 'op-partner', input: { description: 'Новое' } });
  });

  it('«Сохранить» в чате зовёт её же, с владельцем — карточкой гида, и только поле черновика', async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (/FROM tour_chat_edits\s+WHERE id = \$1::uuid/.test(sql)) {
        return { rows: [{ id: DRAFT, tour_id: '77', candidate_ids: [], field: 'base_price', new_value: 16000, live_value: 15000, status: 'pending', expired: false }] };
      }
      if (/FROM operator_tours t\s+WHERE t\.id = \$2::bigint AND t\.operator_id = \$1::uuid AND t\.deleted_at IS NULL\s+FOR UPDATE/.test(sql)) {
        return { rows: [tourRow()] };
      }
      return { rows: [], rowCount: 1 };
    });
    h.write.mockResolvedValue({ outcome: 'written', row: { id: '77', title: 'Восхождение на Горелый', updated_at: 'now' } });
    const r = await saveDraft({ partnerId: GUIDE.partnerId, channel: 'max', chatId: 1, draftId: DRAFT });
    expect(r.kind).toBe('saved');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write.mock.calls[0]![1]).toMatchObject({ tourId: '77', ownerId: GUIDE.partnerId, input: { base_price: 16000 } });
    expect(Object.keys(h.write.mock.calls[0]![1].input)).toEqual(['base_price']);
  });

  it('тур не этой карточки под блокировкой не нашёлся — запись не зовётся', async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (/FROM tour_chat_edits\s+WHERE id = \$1::uuid/.test(sql)) {
        return { rows: [{ id: DRAFT, tour_id: '99', candidate_ids: [], field: 'base_price', new_value: 1000, live_value: 15000, status: 'pending', expired: false }] };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = await saveDraft({ partnerId: GUIDE.partnerId, channel: 'max', chatId: 1, draftId: DRAFT });
    expect(r.kind).toBe('tour_gone');
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe('помощник-модель тур не правит', () => {
  it('гиду со своими турами промпт говорит: тексты и цену не меняешь, сохраняет кнопка', () => {
    const p = partnerSystemPrompt({ ...GUIDE, partnerName: 'Гид' }, Date.UTC(2026, 9, 30), true);
    expect(p).toMatch(/Тексты и цену своих туров ты сам не меняешь и не говоришь, что изменил или сохранил их/);
    expect(p).toMatch(/записывается только она/);
  });
});
