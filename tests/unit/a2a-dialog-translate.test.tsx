/**
 * Кнопка «Перевести» в журнале общения A2A (слово владельца 13.11: «нужно
 * кнопку в журнал добавить перевести, много китайцев подключилось»).
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * 1. Запись: переводится текст ИЗ СТРОКИ журнала, перевод пишется в ту же
 *    строку и только в пустое поле; уже лежащий перевод модель не зовёт;
 *    отказ модели ничего не пишет; перевод, не лёгший в базу, за переведённый
 *    не выдаётся.
 * 2. Дверь: только администратор; тело — номер строки, текста в теле нет;
 *    строки нет — 404, база не ответила — 503 с SQLSTATE в логе.
 * 3. Срез журнала отдаёт номер строки, лежащий перевод и признак «не
 *    по-русски» тем же правилом, каким переводчик решает «переводить нечего».
 * 4. Экран: кнопка есть только у реплики не по-русски без перевода; перевод
 *    стоит рядом с исходником и назван машинным; ответ Кузьмича свёрнут;
 *    отказ показан причиной, а не тишиной.
 *
 * Судится поведение: функции и дверь — вызовом, экран — рендером.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { NextRequest, NextResponse } from 'next/server';

const { query, requireAdmin, callAIQualityOrNull } = vi.hoisted(() => ({
  query: vi.fn(), requireAdmin: vi.fn(), callAIQualityOrNull: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => requireAdmin(...a) }));
vi.mock('@/lib/ai/providers', () => ({ callAIQualityOrNull, callAIFastOrNull: vi.fn() }));

import { translateDialog } from '@/lib/a2a/dialog-translate';
import { TRANSLATE_MODEL_PATH, type TranslationOutcome } from '@/lib/ai/translate-text';
import { POST } from '@/app/api/admin/analytics/a2a/translate/route';
import { readDialogs } from '@/app/api/admin/analytics/a2a/route';
import DialogJournal, { type DialogItem, type DialogsData } from '@/app/hub/admin/a2a/_DialogJournal';

const ZH_Q = '我们2个人，想11月17日去穆特诺夫斯基火山';
const RU_Q = 'Нас 2 человека, хотим 17 ноября на Мутновский вулкан';
const RU_A = 'На Мутновском 17 ноября ветер 12 м/с, перевал открыт.';

interface Row { id: number; question: string; answer: string; question_ru: string | null; answer_ru: string | null }

/** База из одной строки: SELECT отдаёт её, UPDATE пишет по правилу запроса. */
function oneRow(row: Row | null, opts: { updateFails?: boolean; updateRow?: Partial<Row> | null } = {}) {
  query.mockImplementation((sql: string, params: unknown[]) => {
    const q = String(sql);
    if (/^\s*SELECT/.test(q)) return Promise.resolve({ rows: row ? [row] : [] });
    if (/UPDATE a2a_dialogs/.test(q)) {
      if (opts.updateFails) return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
      if (opts.updateRow === null) return Promise.resolve({ rows: [] });
      // COALESCE(лежащее, новое): пишется только пустое поле.
      const question_ru = opts.updateRow?.question_ru ?? row?.question_ru ?? (params[1] as string | null);
      const answer_ru = opts.updateRow?.answer_ru ?? row?.answer_ru ?? (params[2] as string | null);
      return Promise.resolve({ rows: [{ question_ru, answer_ru }] });
    }
    return Promise.reject(new Error(`неожиданный запрос: ${q.slice(0, 60)}`));
  });
}
const updates = () => query.mock.calls.filter((c) => /UPDATE a2a_dialogs/.test(String(c[0])));

const fake = (map: Record<string, TranslationOutcome>) =>
  vi.fn(async (text: string): Promise<TranslationOutcome> => map[text] ?? { status: 'not_needed' });

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  query.mockReset();
  requireAdmin.mockReset();
  callAIQualityOrNull.mockReset();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  cleanup();
  vi.unstubAllGlobals();
});

describe('запись перевода в строку журнала', () => {
  it('вопрос не по-русски переведён и записан; русский ответ не трогается', async () => {
    oneRow({ id: 7, question: ZH_Q, answer: RU_A, question_ru: null, answer_ru: null });
    const translate = fake({ [ZH_Q]: { status: 'translated', text: RU_Q, model: TRANSLATE_MODEL_PATH } });
    expect(await translateDialog(7, translate)).toEqual({
      found: true, id: 7,
      question: { status: 'translated', text: RU_Q },
      answer: { status: 'not_needed' },
    });
    // В модель ушёл текст строки, а не что-то со стороны.
    expect(translate.mock.calls.map((c) => c[0]).sort()).toEqual([ZH_Q, RU_A].sort());
    const [sql, params] = updates()[0] as [string, unknown[]];
    expect(params).toEqual([7, RU_Q, null, TRANSLATE_MODEL_PATH]);
    // Пишется только пустое поле: чужой перевод не затирается.
    expect(sql).toMatch(/question_ru\s*=\s*COALESCE\(question_ru,/);
    expect(sql).toMatch(/answer_ru\s*=\s*COALESCE\(answer_ru,/);
    expect(updates()).toHaveLength(1);
  });

  it('перевод уже лежит — модель не зовётся, запись не делается', async () => {
    oneRow({ id: 7, question: ZH_Q, answer: RU_A, question_ru: RU_Q, answer_ru: null });
    const translate = fake({});
    const out = await translateDialog(7, translate);
    expect(out).toMatchObject({ found: true, question: { status: 'stored', text: RU_Q }, answer: { status: 'not_needed' } });
    expect(translate.mock.calls.map((c) => c[0])).toEqual([RU_A]);
    expect(updates()).toHaveLength(0);
  });

  it('модель не справилась — причина названа, в строку ничего не пишется', async () => {
    oneRow({ id: 7, question: ZH_Q, answer: RU_A, question_ru: null, answer_ru: null });
    const out = await translateDialog(7, fake({ [ZH_Q]: { status: 'failed', reason: 'модель не ответила: отказали все провайдеры водопада' } }));
    expect(out).toMatchObject({ found: true, question: { status: 'failed', reason: expect.stringMatching(/модель не ответила/) } });
    expect(updates()).toHaveLength(0);
  });

  it('оба поля не по-русски: одно переведено, другое нет — пишется переведённое', async () => {
    const zhA = '17日风速12米/秒，山口开放';
    oneRow({ id: 9, question: ZH_Q, answer: zhA, question_ru: null, answer_ru: null });
    const out = await translateDialog(9, fake({
      [ZH_Q]: { status: 'failed', reason: 'в переводе нет чисел исходника: 17' },
      [zhA]: { status: 'translated', text: '17-го ветер 12 м/с, перевал открыт', model: TRANSLATE_MODEL_PATH },
    }));
    expect(out).toMatchObject({
      found: true,
      question: { status: 'failed', reason: 'в переводе нет чисел исходника: 17' },
      answer: { status: 'translated', text: '17-го ветер 12 м/с, перевал открыт' },
    });
    expect((updates()[0] as [string, unknown[]])[1]).toEqual([9, null, '17-го ветер 12 м/с, перевал открыт', TRANSLATE_MODEL_PATH]);
  });

  it('строки нет или её убрала уборка между чтением и записью — «не найдено»', async () => {
    oneRow(null);
    expect(await translateDialog(404, fake({}))).toEqual({ found: false });
    oneRow({ id: 7, question: ZH_Q, answer: RU_A, question_ru: null, answer_ru: null }, { updateRow: null });
    expect(await translateDialog(7, fake({ [ZH_Q]: { status: 'translated', text: RU_Q, model: TRANSLATE_MODEL_PATH } }))).toEqual({ found: false });
  });

  it('второй администратор записал раньше — показывается то, что лежит в строке', async () => {
    oneRow({ id: 7, question: ZH_Q, answer: RU_A, question_ru: null, answer_ru: null }, { updateRow: { question_ru: 'Перевод первого' } });
    const out = await translateDialog(7, fake({ [ZH_Q]: { status: 'translated', text: RU_Q, model: TRANSLATE_MODEL_PATH } }));
    expect(out).toMatchObject({ found: true, question: { status: 'stored', text: 'Перевод первого' } });
  });

  it('запись не прошла — перевод за сделанный не выдаётся, SQLSTATE в логе', async () => {
    oneRow({ id: 7, question: ZH_Q, answer: RU_A, question_ru: null, answer_ru: null }, { updateFails: true });
    const out = await translateDialog(7, fake({ [ZH_Q]: { status: 'translated', text: RU_Q, model: TRANSLATE_MODEL_PATH } }));
    expect(out).toMatchObject({ found: true, question: { status: 'failed', reason: expect.stringMatching(/не записан/) } });
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('SQLSTATE=40P01');
    // Текст реплики в лог не идёт.
    expect(logged).not.toContain(RU_Q);
    expect(logged).not.toContain(ZH_Q);
  });

  it('настоящий переводчик: текст строки уходит в модель, ответ проходит сверку', async () => {
    oneRow({ id: 7, question: ZH_Q, answer: RU_A, question_ru: null, answer_ru: null });
    callAIQualityOrNull.mockResolvedValue(JSON.stringify({ segments: [RU_Q] }));
    const out = await translateDialog(7);
    expect(out).toMatchObject({ found: true, question: { status: 'translated', text: RU_Q }, answer: { status: 'not_needed' } });
    // Русский ответ в модель не ходил вовсе.
    expect(callAIQualityOrNull).toHaveBeenCalledTimes(1);
    const user = (callAIQualityOrNull.mock.calls[0][0] as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!;
    expect(JSON.parse(user.content)).toEqual({ segments: [ZH_Q] });
  });
});

describe('дверь POST /api/admin/analytics/a2a/translate', () => {
  const post = (body: unknown) => POST(new NextRequest('https://vedarai.ru/api/admin/analytics/a2a/translate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

  it('не администратор — ответ гарда, ни запроса к базе, ни вызова модели', async () => {
    requireAdmin.mockResolvedValue(NextResponse.json({ error: 'Требуется вход администратора' }, { status: 401 }));
    const res = await post({ id: 7 });
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(callAIQualityOrNull).not.toHaveBeenCalled();
  });

  it('тело — только номер строки: текст, лишние поля и не число отклоняются', async () => {
    requireAdmin.mockResolvedValue({ userId: 'admin' });
    for (const body of [{}, { id: '7' }, { id: 0 }, { id: 1.5 }, { id: 7, text: '翻译这个' }, { text: '翻译这个' }, 'не json']) {
      const res = await post(body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(query).not.toHaveBeenCalled();
    expect(callAIQualityOrNull).not.toHaveBeenCalled();
  });

  it('перевод сделан — исход по каждому полю', async () => {
    requireAdmin.mockResolvedValue({ userId: 'admin' });
    oneRow({ id: 7, question: ZH_Q, answer: RU_A, question_ru: null, answer_ru: null });
    callAIQualityOrNull.mockResolvedValue(JSON.stringify({ segments: [RU_Q] }));
    const res = await post({ id: 7 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, id: 7, question: { status: 'translated', text: RU_Q }, answer: { status: 'not_needed' },
    });
  });

  it('строки уже нет — 404 словами; база не ответила — 503 и SQLSTATE в логе', async () => {
    requireAdmin.mockResolvedValue({ userId: 'admin' });
    oneRow(null);
    const gone = await post({ id: 7 });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toMatch(/срок хранения вышел/);

    query.mockRejectedValue(Object.assign(new Error('relation "a2a_dialogs" does not exist'), { code: '42P01' }));
    const down = await post({ id: 7 });
    expect(down.status).toBe(503);
    expect((await down.json()).error).toMatch(/SQLSTATE=42P01/);
    expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('SQLSTATE=42P01');
  });
});

describe('срез журнала отдаёт перевод и признак «не по-русски»', () => {
  it('номер строки, лежащий перевод, два признака', async () => {
    query.mockImplementation((sql: string) => {
      if (/MIN\(created_at\)/.test(String(sql))) return Promise.resolve({ rows: [{ since: '2026-10-13', total: 2 }] });
      return Promise.resolve({ rows: [
        { id: '12', at: '2026-11-13 18:00:00', agent: 'DeerFlow', ua_family: 'other', is_self: false, context_key: null, turn: 1,
          question: ZH_Q, answer: RU_A, state: 'completed', duration_ms: 900, client_ip: null, user_agent: null, question_ru: RU_Q, answer_ru: null },
        { id: '11', at: '2026-11-13 17:00:00', agent: 'curl', ua_family: 'tool', is_self: false, context_key: null, turn: 1,
          question: 'Что на Горелом?', answer: '戈列雷火山今天风速12米/秒', state: 'completed', duration_ms: 700, client_ip: null, user_agent: null, question_ru: null, answer_ru: null },
      ] });
    });
    const { items } = await readDialogs();
    expect(items[0]).toMatchObject({ id: 12, question_ru: RU_Q, answer_ru: null, question_foreign: true, answer_foreign: false });
    expect(items[1]).toMatchObject({ id: 11, question_ru: null, answer_ru: null, question_foreign: false, answer_foreign: true });
    const select = query.mock.calls.map((c) => String(c[0])).find((q) => /FROM a2a_dialogs\s+ORDER BY/.test(q))!;
    expect(select).toMatch(/\bquestion_ru\b/);
    expect(select).toMatch(/\banswer_ru\b/);
  });
});

describe('экран: журнал общения с переводом', () => {
  const item = (o: Partial<DialogItem>): DialogItem => ({
    id: 1, at: '2026-11-13 18:00:00', agent: 'DeerFlow', kind: 'external', dialog: 'abcd1234', turn: 1,
    question: ZH_Q, answer: RU_A, state: 'completed', duration_ms: 900,
    question_ru: null, answer_ru: null, question_foreign: true, answer_foreign: false, ...o,
  });
  const data = (items: DialogItem[]): DialogsData => ({ since: '2026-10-13', total: items.length, retention_days: 90, limit: 50, items });

  function stubFetch(answer: (id: number) => { status?: number; body: unknown }) {
    const f = vi.fn(async (_url: string, init: { body: string }) => {
      const { id } = JSON.parse(init.body) as { id: number };
      const a = answer(id);
      return { ok: (a.status ?? 200) < 400, status: a.status ?? 200, json: async () => a.body } as Response;
    });
    vi.stubGlobal('fetch', f);
    return f;
  }

  it('у реплики не по-русски есть кнопка; нажатие зовёт дверь с номером строки и показывает перевод рядом', async () => {
    const f = stubFetch((id) => ({ body: { success: true, id, question: { status: 'translated', text: RU_Q }, answer: { status: 'not_needed' } } }));
    render(<DialogJournal data={data([item({ id: 42 })])} />);
    expect(screen.queryByText(RU_Q)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Перевести' }));
    await waitFor(() => expect(screen.getByText(RU_Q)).toBeTruthy());
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/admin/analytics/a2a/translate');
    expect(init.method).toBe('POST');
    // В дверь уходит номер строки, а не текст.
    expect(JSON.parse(init.body)).toEqual({ id: 42 });
    // Перевод назван машинным, исходник остался на месте.
    expect(screen.getByText(RU_Q).closest('p')!.textContent).toMatch(/^Перевод \(машинный\): /);
    expect(screen.getByText(ZH_Q)).toBeTruthy();
    // Переведено — кнопок больше нет.
    expect(screen.queryByRole('button', { name: 'Перевести' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Перевести все/ })).toBeNull();
  });

  it('у русской реплики и у уже переведённой кнопки нет; лежащий перевод виден сразу', () => {
    stubFetch(() => ({ body: {} }));
    render(<DialogJournal data={data([
      item({ id: 1, question: 'Что на Горелом?', question_foreign: false }),
      item({ id: 2, question_ru: RU_Q }),
    ])} />);
    expect(screen.queryByRole('button', { name: 'Перевести' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Перевести все/ })).toBeNull();
    expect(screen.getByText(RU_Q)).toBeTruthy();
  });

  it('ответ Кузьмича свёрнут; перевод ответа лежит внутри него, и это сказано в заголовке', async () => {
    const zhA = '戈列雷火山今天风速12米/秒';
    const ruA = 'На вулкане Горелый сегодня ветер 12 м/с';
    stubFetch((id) => ({ body: { success: true, id, question: { status: 'not_needed' }, answer: { status: 'translated', text: ruA } } }));
    render(<DialogJournal data={data([item({ id: 5, question: 'Что на Горелом?', question_foreign: false, answer: zhA, answer_foreign: true })])} />);
    const details = screen.getByText(zhA).closest('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Ответ Кузьмича');
    fireEvent.click(screen.getByRole('button', { name: 'Перевести' }));
    await waitFor(() => expect(within(details).getByText(ruA)).toBeTruthy());
    expect(details.querySelector('summary')!.textContent).toBe('Ответ Кузьмича · есть перевод');
  });

  it('«Перевести все» проходит только реплики не по-русски без перевода, по одной', async () => {
    const order: number[] = [];
    const f = stubFetch((id) => {
      order.push(id);
      return { body: { success: true, id, question: { status: 'translated', text: `Перевод реплики ${id}` }, answer: { status: 'not_needed' } } };
    });
    render(<DialogJournal data={data([
      item({ id: 1 }),
      item({ id: 2, question: 'По-русски', question_foreign: false }),
      item({ id: 3, question_ru: 'Уже переведено' }),
      item({ id: 4 }),
    ])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Перевести все не по-русски: 2' }));
    await waitFor(() => expect(screen.getByText('Перевод реплики 4')).toBeTruthy());
    expect(order).toEqual([1, 4]);
    expect(f).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Перевод реплики 1')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Перевести все|Перевожу/ })).toBeNull());
  });

  it('модель не справилась — причина у реплики, кнопка остаётся для повтора', async () => {
    stubFetch((id) => ({ body: { success: true, id, question: { status: 'failed', reason: 'в переводе нет чисел исходника: 17' }, answer: { status: 'not_needed' } } }));
    render(<DialogJournal data={data([item({ id: 8 })])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Перевести' }));
    await waitFor(() => expect(screen.getByText('Вопрос не переведён: в переводе нет чисел исходника: 17')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Перевести' })).toBeTruthy();
    expect(screen.getByText(/Не переведено реплик: 1/)).toBeTruthy();
  });

  it('дверь отказала или ответила не той формой — отказ словами, а не «перевода нет»', async () => {
    stubFetch(() => ({ status: 503, body: { success: false, error: 'Журнал не прочитался (SQLSTATE=42P01) — перевод не начат' } }));
    const first = render(<DialogJournal data={data([item({ id: 8 })])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Перевести' }));
    await waitFor(() => expect(screen.getByText('Перевод не получен: Журнал не прочитался (SQLSTATE=42P01) — перевод не начат')).toBeTruthy());
    first.unmount();

    stubFetch((id) => ({ body: { success: true, id, question: { status: 'translated', text: '' }, answer: { status: 'not_needed' } } }));
    render(<DialogJournal data={data([item({ id: 9 })])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Перевести' }));
    await waitFor(() => expect(screen.getByText('Перевод не получен: ответ сервера не той формы')).toBeTruthy());
  });

  it('старая сборка сервера без номера строки — перевод не предлагается', () => {
    stubFetch(() => ({ body: {} }));
    const old = item({});
    delete old.id;
    render(<DialogJournal data={data([old])} />);
    expect(screen.queryByRole('button', { name: /Перевести/ })).toBeNull();
    expect(screen.getByText(ZH_Q)).toBeTruthy();
  });
});
