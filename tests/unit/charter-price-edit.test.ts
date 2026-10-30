/**
 * Прайс перевозчика из кабинета — черновиком на модерацию (#2862 этап C,
 * миграция 1355). Сторож — вызовом, на граничных данных:
 *
 *  - команда «цена <направление|час|день|доплата> <рубли>» разбирается, вопрос
 *    и «описание …» командой цены не становятся;
 *  - чужой партнёр (не перевозчик, пилот проката) — null: путь не его;
 *  - строка прайса ищется той же мерой, что поиск и заявка; несколько —
 *    не выбираем; «8 500» — не угадываем;
 *  - черновик пишется ON CONFLICT одного pending на строку и дополняет его
 *    COALESCE; пустой черновик в базу не идёт;
 *  - одобрение: правка — UPDATE живой строки, новая — INSERT; дубль по
 *    индексу — `duplicate` с откатом; расхождение с тем, что видел модератор,
 *    — `changed`; отказ живую строку не пишет;
 *  - партнёру — решение с причиной, без ПД, одним текстом в оба канала.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatRub } from '@/lib/transfers/charter-format';

const query = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => query(...a),
    connect: async () => ({ query: clientQuery, release }),
  },
}));

const PARTNER = '22222222-2222-4222-8222-222222222222';
const PRICE = '11111111-1111-4111-8111-111111111111';
const EDIT = '33333333-3333-4333-8333-333333333333';

const priceDb = (over: Record<string, unknown> = {}) => ({
  id: PRICE, vehicle_kind: 'vahtovka', line_kind: 'destination', from_text: 'Петропавловск', to_text: 'Авачинский',
  price_rub: 65000, price_note: null, conditions: null, valid_year: 2026, is_active: true, ...over,
});

beforeEach(() => {
  query.mockReset();
  clientQuery.mockReset();
  release.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('команда «цена …»', () => {
  it('направление, час, день, доплата; вопрос и описание — не команда цены', async () => {
    const { parseCharterPriceEdit, isCharterPriceEditAsk } = await import('@/lib/transfers/price-edit');
    expect(parseCharterPriceEdit('цена Авачинский 65000')).toEqual({
      ok: true, command: { target: { kind: 'destination', words: 'Авачинский' }, priceRub: 65000 },
    });
    expect(parseCharterPriceEdit('Цену за час 4500')).toEqual({ ok: true, command: { target: { kind: 'rate', unit: 'hour' }, priceRub: 4500 } });
    expect(parseCharterPriceEdit('цена полный день 25000')).toEqual({ ok: true, command: { target: { kind: 'rate', unit: 'day' }, priceRub: 25000 } });
    expect(parseCharterPriceEdit('цена доплата 15000')).toEqual({ ok: true, command: { target: { kind: 'extra_day' }, priceRub: 15000 } });
    expect(parseCharterPriceEdit('цена день на месте 15000')).toEqual({ ok: true, command: { target: { kind: 'extra_day' }, priceRub: 15000 } });
    // «8 500» читается двояко — решает прайс.
    const spaced = parseCharterPriceEdit('цена Горелый 8 500');
    expect(spaced.ok && spaced.command.alsoReadsAs).toEqual({ words: 'Горелый', spacedPrice: '8 500' });
    // «65 000» — последнее число 000: не цена.
    expect(parseCharterPriceEdit('цена Авачинский 65 000')).toEqual({ ok: false, reason: 'bad_price' });
    expect(parseCharterPriceEdit('цена Авачинский 0')).toEqual({ ok: false, reason: 'bad_price' });
    expect(parseCharterPriceEdit('цена Авачинский')).toEqual({ ok: false, reason: 'format' });
    expect(isCharterPriceEditAsk('цена на Авачинский какая?')).toBe(false);
    expect(isCharterPriceEditAsk('сколько стоит до Авачинского')).toBe(false);
    expect(parseCharterPriceEdit('описание Авачинский: с переправами')).toEqual({ ok: false, reason: 'conditions_not_here' });
  });

  it('тексты: подсказка без цен и HTML, отказы экранируют слова человека', async () => {
    const m = await import('@/lib/transfers/price-edit');
    expect(m.charterPriceFormatHint()).toContain('«цена Авачинский 65000»');
    expect(m.charterPriceFormatHint()).toContain('черновик');
    expect(m.charterPriceMissingText('Гор<елый>')).toContain('Гор&lt;елый&gt;');
    expect(m.charterPriceAmbiguousText('Горелый', ['A <1>', 'B'])).toContain('«A &lt;1&gt;», «B»');
    expect(m.charterPriceRejectText({ ok: false, reason: 'conditions_not_here' })).toContain('кабинете на сайте');
    expect(m.charterPriceSavedText({ label: 'Петропавловск — Авачинский (вахтовка)', livePrice: 65000, draftPrice: 70000, live: true }))
      .toContain(`${formatRub(70000)}. Сейчас в прайсе: ${formatRub(65000)}`);
    expect(m.charterPriceSavedText({ label: 'x', livePrice: 1, draftPrice: 2, live: false })).toContain('скрыта с сайта');
  });

  it('подпись строки: направление, доплата, час и день — с видом машины', async () => {
    const { priceRowLabel, checkNewRowShape } = await import('@/lib/transfers/price-edit');
    expect(priceRowLabel({ lineKind: 'destination', fromText: 'ПК', toText: 'Горелый', vehicleKind: 'jeep' })).toBe('ПК — Горелый (джип)');
    expect(priceRowLabel({ lineKind: 'extra_day', fromText: null, toText: null, vehicleKind: 'vahtovka' })).toBe('Доплата за день на месте (вахтовка)');
    expect(priceRowLabel({ lineKind: 'per_hour', fromText: null, toText: null, vehicleKind: 'minibus' })).toBe('Час работы машины (микроавтобус)');
    expect(priceRowLabel({ lineKind: 'per_day', fromText: null, toText: null, vehicleKind: 'other' })).toBe('Полный день (транспорт)');
    // Форма новой строки — та же, что CHECK в базе.
    const base = { vehicleKind: 'jeep' as const, priceRub: 1000, priceNote: null, conditions: null, validYear: null };
    expect(checkNewRowShape({ ...base, lineKind: 'destination', fromText: 'A', toText: null })).toEqual({ ok: false, reason: 'destination_needs_texts' });
    expect(checkNewRowShape({ ...base, lineKind: 'per_hour', fromText: 'A', toText: null })).toEqual({ ok: false, reason: 'rate_has_texts' });
    expect(checkNewRowShape({ ...base, lineKind: 'per_hour', fromText: null, toText: null, priceRub: 0 })).toEqual({ ok: false, reason: 'bad_price' });
    expect(checkNewRowShape({ ...base, lineKind: 'destination', fromText: 'A', toText: 'B', validYear: 1999 })).toEqual({ ok: false, reason: 'bad_year' });
    expect(checkNewRowShape({ ...base, lineKind: 'destination', fromText: 'A', toText: 'B' })).toEqual({ ok: true });
  });
});

describe('поток в чате', () => {
  const rows = (list: Array<Record<string, unknown>>) => { query.mockResolvedValue({ rows: list }); };

  it('не перевозчик и пилот проката — null; вопрос — null', async () => {
    const { handleCharterPriceEdit } = await import('@/lib/transfers/price-edit-flow');
    expect(await handleCharterPriceEdit({ partnerId: PARTNER, category: 'operator', slug: 'op', text: 'цена Авачинский 65000' })).toBeNull();
    expect(await handleCharterPriceEdit({ partnerId: PARTNER, category: 'transfer', slug: 'laguna-prokat', text: 'цена Авачинский 65000' })).toBeNull();
    expect(await handleCharterPriceEdit({ partnerId: PARTNER, category: 'transfer', slug: 'shatun', text: 'цена какая на Авачинский?' })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('направление найдено одно — черновик записан, живая цена названа', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/FROM transfer_charter_prices/.test(sql)) return { rows: [priceDb()] };
      if (/INSERT INTO transfer_charter_price_edits/.test(sql)) {
        return { rows: [{ id: EDIT, price_rub: 70000, price_note: null, conditions: null, is_active: null }] };
      }
      return { rows: [] };
    });
    const { handleCharterPriceEdit } = await import('@/lib/transfers/price-edit-flow');
    const text = await handleCharterPriceEdit({ partnerId: PARTNER, category: 'transfer', slug: 'shatun', text: 'цена Авачинский 70000' });
    expect(text).toContain('Черновик записан: Петропавловск — Авачинский (вахтовка)');
    expect(text).toContain(`${formatRub(70000)}. Сейчас в прайсе: ${formatRub(65000)}`);
    const insert = query.mock.calls.find((c) => /INSERT INTO transfer_charter_price_edits/.test(String(c[0])));
    expect(String(insert?.[0])).toMatch(/ON CONFLICT \(price_id\) WHERE moderation_status = 'pending'/);
    expect(String(insert?.[0])).toMatch(/COALESCE\(EXCLUDED\.price_rub/);
    expect(insert?.[1]).toEqual([PARTNER, PRICE, 70000, null, null, null]);
    // Модель не зовётся: ответ собран из прайса.
  });

  it('направления нет — так и сказано; два вида машин на одно направление — не выбираем', async () => {
    const { handleCharterPriceEdit } = await import('@/lib/transfers/price-edit-flow');
    rows([priceDb()]);
    expect(await handleCharterPriceEdit({ partnerId: PARTNER, category: 'transfer', slug: 'shatun', text: 'цена Толбачик 90000' }))
      .toContain('В прайсе нет направления «Толбачик»');
    rows([priceDb(), priceDb({ id: EDIT, vehicle_kind: 'jeep', price_rub: 45000 })]);
    const text = await handleCharterPriceEdit({ partnerId: PARTNER, category: 'transfer', slug: 'shatun', text: 'цена Авачинский 70000' });
    expect(text).toContain('подходят несколько строк прайса');
    expect(text).toContain('(вахтовка)');
    expect(text).toContain('(джип)');
    expect(query.mock.calls.some((c) => /INSERT INTO/.test(String(c[0])))).toBe(false);
  });

  it('«Горелый 8 500» при направлении «Горелый» в прайсе — переспрашиваем, не пишем', async () => {
    rows([priceDb({ to_text: 'Горелый' })]);
    const { handleCharterPriceEdit } = await import('@/lib/transfers/price-edit-flow');
    const text = await handleCharterPriceEdit({ partnerId: PARTNER, category: 'transfer', slug: 'shatun', text: 'цена Горелый 8 500' });
    expect(text).toContain('Не понял цену: «8 500»');
    expect(query.mock.calls.some((c) => /INSERT INTO/.test(String(c[0])))).toBe(false);
  });

  it('тариф за час: нет строки — куда идти; есть — черновик', async () => {
    const { handleCharterPriceEdit } = await import('@/lib/transfers/price-edit-flow');
    rows([priceDb()]);
    expect(await handleCharterPriceEdit({ partnerId: PARTNER, category: 'transfer', slug: 'shatun', text: 'цена час 5000' }))
      .toContain('нет цены за час');
    query.mockImplementation(async (sql: string) => {
      if (/FROM transfer_charter_prices/.test(sql)) return { rows: [priceDb({ line_kind: 'per_hour', from_text: null, to_text: null, price_rub: 4500 })] };
      return { rows: [{ id: EDIT, price_rub: 5000, price_note: null, conditions: null, is_active: null }] };
    });
    expect(await handleCharterPriceEdit({ partnerId: PARTNER, category: 'transfer', slug: 'shatun', text: 'цена час 5000' }))
      .toContain('Час работы машины (вахтовка)');
  });

  it('база не ответила — «не смог записать», не «нет направления»', async () => {
    query.mockRejectedValue(Object.assign(new Error('x'), { code: '57P01' }));
    const { handleCharterPriceEdit } = await import('@/lib/transfers/price-edit-flow');
    expect(await handleCharterPriceEdit({ partnerId: PARTNER, category: 'transfer', slug: 'shatun', text: 'цена Авачинский 70000' }))
      .toContain('Не смог записать черновик');
  });
});

describe('хранилище', () => {
  it('пустой черновик в базу не идёт; новая строка с кривой формой — тоже', async () => {
    const { savePricePatch, saveNewPriceDraft } = await import('@/lib/transfers/price-edit-store');
    const row = {
      id: PRICE, vehicleKind: 'vahtovka' as const, lineKind: 'destination' as const, fromText: 'ПК', toText: 'Авачинский',
      priceRub: 65000, priceNote: null, conditions: null, validYear: null, isActive: true,
    };
    expect(await savePricePatch({ partnerId: PARTNER, row, patch: { priceRub: null, priceNote: null, conditions: null, isActive: null } }))
      .toEqual({ outcome: 'empty' });
    expect(await saveNewPriceDraft({
      partnerId: PARTNER,
      row: { vehicleKind: 'jeep', lineKind: 'destination', fromText: 'ПК', toText: null, priceRub: 1000, priceNote: null, conditions: null, validYear: null },
    })).toEqual({ outcome: 'bad_shape', reason: 'destination_needs_texts' });
    expect(query).not.toHaveBeenCalled();
  });

  function locked(over: Record<string, unknown> = {}) {
    return {
      id: EDIT, partner_id: PARTNER, price_id: PRICE, moderation_status: 'pending',
      d_price_rub: 70000, d_price_note: null, d_conditions: null, d_is_active: null,
      d_vehicle_kind: null, d_line_kind: null, d_from_text: null, d_to_text: null, d_valid_year: null,
      l_id: PRICE, l_vehicle_kind: 'vahtovka', l_line_kind: 'destination', l_from_text: 'ПК', l_to_text: 'Авачинский',
      l_price_rub: 65000, l_price_note: null, l_conditions: null, l_valid_year: 2026, l_is_active: true,
      ...over,
    };
  }
  const seen = (over: Record<string, unknown> = {}) => ({
    priceRub: 70000, priceNote: null, conditions: null, isActive: null,
    vehicleKind: null, lineKind: null, fromText: null, toText: null, validYear: null, ...over,
  });

  function serveLock(row: Record<string, unknown>, onInsert?: () => Promise<{ rows: unknown[] }>) {
    clientQuery.mockClear();
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/FOR UPDATE/.test(sql)) return { rows: [row] };
      if (/UPDATE transfer_charter_prices/.test(sql)) return { rows: [{ id: PRICE }] };
      if (/INSERT INTO transfer_charter_prices/.test(sql)) return onInsert ? onInsert() : { rows: [{ id: 'new' }] };
      if (/UPDATE transfer_charter_price_edits/.test(sql)) return { rows: [{ id: EDIT }] };
      return { rows: [] };
    });
  }

  it('одобрение правки: UPDATE живой строки и approved в одной транзакции', async () => {
    serveLock(locked());
    const { decidePriceEdit } = await import('@/lib/transfers/price-edit-store');
    const r = await decidePriceEdit({ id: EDIT, action: 'approve', reason: null, moderatedBy: null, seen: seen() });
    expect(r).toEqual({ outcome: 'approved', partnerId: PARTNER, label: 'ПК — Авачинский (вахтовка)' });
    const apply = clientQuery.mock.calls.find((c) => /UPDATE transfer_charter_prices/.test(String(c[0])));
    expect(apply?.[1]).toEqual([PRICE, 70000, null, null, null, PARTNER]);
    expect(String(clientQuery.mock.calls.at(-1)?.[0])).toBe('COMMIT');
  });

  it('черновик дописан после показа — changed, живая строка не тронута', async () => {
    serveLock(locked({ d_is_active: false }));
    const { decidePriceEdit } = await import('@/lib/transfers/price-edit-store');
    expect(await decidePriceEdit({ id: EDIT, action: 'approve', reason: null, moderatedBy: null, seen: seen() })).toEqual({ outcome: 'changed' });
    expect(clientQuery.mock.calls.some((c) => /UPDATE transfer_charter_prices/.test(String(c[0])))).toBe(false);
    expect(String(clientQuery.mock.calls.at(-1)?.[0])).toBe('ROLLBACK');
    // Без «что видел» одобрение не применяется вовсе.
    serveLock(locked());
    expect(await decidePriceEdit({ id: EDIT, action: 'approve', reason: null, moderatedBy: null, seen: null })).toEqual({ outcome: 'changed' });
  });

  it('новая строка: INSERT в прайс; дубль по индексу — duplicate с откатом', async () => {
    const fresh = locked({
      price_id: null, l_id: null, l_vehicle_kind: null, l_line_kind: null, l_from_text: null, l_to_text: null, l_price_rub: null, l_is_active: null,
      d_vehicle_kind: 'jeep', d_line_kind: 'destination', d_from_text: 'ПК', d_to_text: 'Горелый', d_price_rub: 45000, d_valid_year: 2026,
    });
    const freshSeen = seen({ priceRub: 45000, vehicleKind: 'jeep', lineKind: 'destination', fromText: 'ПК', toText: 'Горелый', validYear: 2026 });
    serveLock(fresh);
    const { decidePriceEdit } = await import('@/lib/transfers/price-edit-store');
    expect(await decidePriceEdit({ id: EDIT, action: 'approve', reason: null, moderatedBy: null, seen: freshSeen }))
      .toEqual({ outcome: 'approved', partnerId: PARTNER, label: 'ПК — Горелый (джип)' });
    const ins = clientQuery.mock.calls.find((c) => /INSERT INTO transfer_charter_prices/.test(String(c[0])));
    expect(ins?.[1]).toEqual([PARTNER, 'jeep', 'destination', 'ПК', 'Горелый', 45000, null, null, 2026]);

    serveLock(fresh, async () => { throw Object.assign(new Error('dup'), { code: '23505' }); });
    expect(await decidePriceEdit({ id: EDIT, action: 'approve', reason: null, moderatedBy: null, seen: freshSeen }))
      .toEqual({ outcome: 'duplicate', label: 'ПК — Горелый (джип)' });
    expect(String(clientQuery.mock.calls.at(-1)?.[0])).toBe('ROLLBACK');
    expect(clientQuery.mock.calls.some((c) => /UPDATE transfer_charter_price_edits/.test(String(c[0])))).toBe(false);
  });

  it('отказ живую строку не пишет; уже решённый — already; нет такого — not_found', async () => {
    serveLock(locked());
    const { decidePriceEdit } = await import('@/lib/transfers/price-edit-store');
    expect(await decidePriceEdit({ id: EDIT, action: 'reject', reason: 'не та цифра', moderatedBy: null, seen: null }))
      .toEqual({ outcome: 'rejected', partnerId: PARTNER, label: 'ПК — Авачинский (вахтовка)' });
    expect(clientQuery.mock.calls.some((c) => /UPDATE transfer_charter_prices|INSERT INTO transfer_charter_prices/.test(String(c[0])))).toBe(false);
    serveLock(locked({ moderation_status: 'approved' }));
    expect(await decidePriceEdit({ id: EDIT, action: 'reject', reason: 'x'.repeat(5), moderatedBy: null, seen: null })).toEqual({ outcome: 'already' });
    clientQuery.mockImplementation(async (sql: string) => (/FOR UPDATE/.test(sql) ? { rows: [] } : { rows: [] }));
    expect(await decidePriceEdit({ id: EDIT, action: 'reject', reason: 'x'.repeat(5), moderatedBy: null, seen: null })).toEqual({ outcome: 'not_found' });
  });

  it('очередь и черновики читаются без телефона и почты; отказ базы — db_error, не пустота', async () => {
    const { listPendingPriceEdits, loadOwnDrafts } = await import('@/lib/transfers/price-edit-store');
    query.mockResolvedValueOnce({ rows: [] });
    expect(await listPendingPriceEdits()).toEqual({ outcome: 'ok', edits: [] });
    expect(String(query.mock.calls[0][0])).not.toMatch(/phone|email/);
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    expect(await listPendingPriceEdits()).toEqual({ outcome: 'db_error' });
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    expect(await loadOwnDrafts(PARTNER)).toEqual({ outcome: 'db_error' });
  });
});

describe('партнёру — решение', () => {
  it('одобрение и отказ с причиной: один текст в оба канала, без ПД, причина экранирована, адрес строгий', async () => {
    const sendPdAlert = vi.fn(async () => ({ channel: 'max', delivered: true, reason: 'ok' }));
    const reachForPartner = vi.fn(async () => ({ reachable: true, maxChatId: '77', telegramChatId: null }));
    vi.doMock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => sendPdAlert(...a) }));
    vi.doMock('@/lib/partners/reach', () => ({ reachForPartner: (...a: unknown[]) => reachForPartner(...a) }));
    const { notifyPartnerEditDecision, editDecisionText } = await import('@/lib/notifications/partner-edit-notify');
    const r = await notifyPartnerEditDecision({ partnerId: PARTNER, subject: 'charter', label: 'ПК — Авачинский', outcome: 'rejected', reason: 'не та <цифра>' });
    expect(r).toEqual({ state: 'delivered', channel: 'max' });
    const params = sendPdAlert.mock.calls[0]![0] as { text: string; stub: string; to: unknown; buttons: Array<{ url?: string }> };
    expect(params.text).toBe(params.stub);
    expect(params.text).toContain('отклонена');
    expect(params.text).toContain('не та &lt;цифра&gt;');
    expect(params.to).toEqual({ maxChatId: '77', telegramChatId: null });
    expect(params.buttons[0]?.url).toContain('/hub/carrier');
    expect(editDecisionText({ partnerId: PARTNER, subject: 'car_rental', label: 'Jimny', outcome: 'approved', reason: null }))
      .toContain('Правка прайса проката одобрена');
    // Нет канала — названо, не «доставлено».
    reachForPartner.mockResolvedValueOnce({ reachable: false, maxChatId: null, telegramChatId: null });
    expect(await notifyPartnerEditDecision({ partnerId: PARTNER, subject: 'charter', label: 'x', outcome: 'approved', reason: null }))
      .toEqual({ state: 'no_channel' });
    vi.doUnmock('@/lib/notifications/pd-alert');
    vi.doUnmock('@/lib/partners/reach');
  });
});
