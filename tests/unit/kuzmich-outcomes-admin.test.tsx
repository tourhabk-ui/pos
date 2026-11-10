/**
 * Плохие оценки Кузьмича случаями — экран администратора (#3179, 10.11).
 *
 * Владелец: «3179 да и нужно решение». Еженедельный свод в публичном issue
 * называет только числа и номера; здесь случай открывается целиком: вопрос,
 * ответ, слова судьи. Сторож судит поведение:
 *  - дверь одна: не администратор — ответа нет и в базу не ходит;
 *  - телефоны и почта сняты при чтении, даже если запись легла без чистки;
 *  - отказ базы — «не прочиталось» (503), а не пустой список; в лог — только
 *    SQLSTATE, без текста;
 *  - экран рисует вопрос, ответ и судью, фильтрует по типу проблемы,
 *    говорит «судья не писал», когда оценок нет вовсе, и копирует для
 *    разбора только поля экрана;
 *  - свод в публичном issue ведёт на экран, а сам случаев не печатает;
 *  - экран есть в меню админки.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { NextRequest, NextResponse } from 'next/server';

const { query, requireAdmin } = vi.hoisted(() => ({ query: vi.fn(), requireAdmin: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin }));
vi.mock('@/components/auth/Protected', () => ({
  Protected: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import { GET } from '@/app/api/admin/kuzmich-outcomes/route';
import KuzmichOutcomesClient from '@/app/hub/admin/kuzmich-outcomes/_KuzmichOutcomesClient';
import {
  CASES_LIMIT, caseClusters, casesForReview, parseDays, parseOutcomeCase, type OutcomeCase, type OutcomeCaseRow,
} from '@/lib/kuzmich/bad-outcome-cases';

const ROOT = process.cwd();

const row = (over: Partial<OutcomeCaseRow>): OutcomeCaseRow => ({
  id: 11,
  created_at: '2026-11-09T10:00:00Z',
  compiled_truth: 'Вопрос: Как дойти до Авачинского?\nОтвет: Идите по тропе.\n\nОценка 4/10. Проблемы: Не упомянута безопасность; Выдуманная цена тура',
  surface: 'telegram', provider: 'deepseek', answer_path: 'tools', outcome_kind: null, tools_ran: ['get_place_info'], score: 4,
  ...over,
});

const REFUSAL = row({
  id: 13, outcome_kind: 'refusal', score: null, surface: 'max', tools_ran: null,
  compiled_truth: 'Вопрос: что взять в поход\nОтвет: Я не могу помочь\n\nОТКАЗ МОДЕЛИ. Признаки: cannot. Балла нет: модель не отвечала на вопрос.',
});

describe('разбор записи грейдера', () => {
  it('вопрос, ответ, проблемы по одной, типы — те же, что в своде', () => {
    const c = parseOutcomeCase(row({}));
    expect(c).toMatchObject({
      id: 11, score: 4, refusal: false, surface: 'telegram', tools: ['get_place_info'],
      question: 'Как дойти до Авачинского?', answer: 'Идите по тропе.',
      issues: ['Не упомянута безопасность', 'Выдуманная цена тура'],
    });
    expect(c.clusters.map((k) => k.id)).toEqual(['safety_missing', 'invented']);
  });

  it('отказ модели — без балла, слова отказа видны, тип «Отказ модели»', () => {
    const c = parseOutcomeCase(REFUSAL);
    expect(c.refusal).toBe(true);
    expect(c.score).toBeNull();
    expect(c.issues[0]).toContain('ОТКАЗ МОДЕЛИ');
    expect(c.clusters).toEqual([{ id: 'refusal', label: 'Отказ модели' }]);
  });

  it('телефон и почта снимаются при чтении — во всех трёх полях', () => {
    const c = parseOutcomeCase(row({
      compiled_truth: 'Вопрос: мой номер +7 999 123-45-67\nОтвет: пишите на guest@example.com\n\nОценка 3/10. Проблемы: повторил телефон 89991234567',
    }));
    const text = JSON.stringify(c);
    expect(text).not.toMatch(/123-45-67|89991234567|guest@example\.com/);
  });

  it('запись другой формы не выбрасывается: вопроса нет, судья виден', () => {
    const c = parseOutcomeCase(row({ compiled_truth: 'Оценка 5/10. Проблемы: НЕЗАЗЕМЛЁННЫЕ ФАКТЫ (price): цена' }));
    expect(c.question).toBe('');
    expect(c.issues).toEqual(['НЕЗАЗЕМЛЁННЫЕ ФАКТЫ (price): цена']);
    expect(caseClusters('Оценка 2/10.', null)).toEqual([{ id: 'no_issue_text', label: 'Низкий балл без текста проблем' }]);
  });

  it('окно в днях держится в 1–90', () => {
    expect(parseDays(null)).toBe(7);
    expect(parseDays('0')).toBe(1);
    expect(parseDays('500')).toBe(90);
    expect(parseDays('abc')).toBe(7);
  });

  it('текст для разбора — только поля экрана, без поверхности-кода и служебного', () => {
    const text = casesForReview([parseOutcomeCase(row({})), parseOutcomeCase(REFUSAL)]);
    expect(text).toContain('Случай #11 · оценка 4/10 · Telegram · инструменты: get_place_info');
    expect(text).toContain('Вопрос: Как дойти до Авачинского?');
    expect(text).toContain('Судья: Не упомянута безопасность; Выдуманная цена тура');
    expect(text).toContain('Случай #13 · отказ модели · MAX · без инструментов');
    expect(text).not.toMatch(/deepseek|answer_path|tools_ran|nokey/);
  });
});

describe('GET /api/admin/kuzmich-outcomes', () => {
  const req = (q = '') => new NextRequest(`https://vedarai.ru/api/admin/kuzmich-outcomes${q}`);

  beforeEach(() => {
    query.mockReset();
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ userId: 'admin-1' });
    query.mockImplementation((sql: string) =>
      Promise.resolve({ rows: /COUNT\(\*\)::int AS n/.test(sql) ? [{ n: 30 }] : [row({}), REFUSAL] }));
  });

  it('не администратор — отказ двери, в базу не ходит', async () => {
    requireAdmin.mockResolvedValue(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
    expect((await GET(req())).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('отдаёт случаи и общее число оценок; окно передано в запрос', async () => {
    const res = await GET(req('?days=30'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.days).toBe(30);
    expect(json.data.outcomes_total).toBe(30);
    expect(json.data.truncated).toBe(false);
    expect(json.data.cases.map((c: OutcomeCase) => c.id)).toEqual([11, 13]);
    const casesCall = query.mock.calls.find(([sql]) => !/COUNT\(\*\)::int AS n/.test(sql as string))!;
    expect(casesCall[1]).toEqual([30, CASES_LIMIT + 1]);
  });

  it('больше потолка — отдаёт потолок и говорит, что список обрезан', async () => {
    const many = Array.from({ length: CASES_LIMIT + 1 }, (_, i) => row({ id: i + 1 }));
    query.mockImplementation((sql: string) =>
      Promise.resolve({ rows: /COUNT\(\*\)::int AS n/.test(sql) ? [{ n: 999 }] : many }));
    const json = await (await GET(req())).json();
    expect(json.data.cases).toHaveLength(CASES_LIMIT);
    expect(json.data.truncated).toBe(true);
  });

  it('отказ базы — 503 «не прочитались», в лог только SQLSTATE', async () => {
    const err = Object.assign(new Error('relation "agent_knowledge" ... Вопрос: +7 999 123-45-67'), { code: '42P01' });
    query.mockRejectedValue(err);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('не прочитались');
    const logged = spy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('SQLSTATE=42P01');
    expect(logged).not.toContain('123-45-67');
    spy.mockRestore();
  });
});

describe('экран «Кузьмич: плохие оценки»', () => {
  const data = (cases: OutcomeCase[], total = 30) => ({ success: true, data: { days: 7, outcomes_total: total, cases, truncated: false } });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const respond = (body: unknown, status = 200) =>
    fetchMock.mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) });

  it('показывает вопрос, ответ и слова судьи; фильтр по типу проблемы', async () => {
    respond(data([parseOutcomeCase(row({})), parseOutcomeCase(REFUSAL)]));
    render(<KuzmichOutcomesClient />);
    expect(await screen.findByText('Как дойти до Авачинского?')).toBeTruthy();
    expect(screen.getByText('Идите по тропе.')).toBeTruthy();
    // Слова судьи — пунктом списка, тип проблемы — значком: «Не упомянута безопасность» есть и там, и там.
    expect(screen.getByText('Выдуманная цена тура').tagName).toBe('LI');
    expect(screen.getAllByText('Не упомянута безопасность').map((el) => el.tagName).sort()).toEqual(['LI', 'SPAN']);
    expect(screen.getByText('Оценка 4/10')).toBeTruthy();
    expect(screen.getAllByText('Отказ модели').length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/kuzmich-outcomes?days=7');

    const filters = screen.getByRole('group', { name: 'Тип проблемы' });
    fireEvent.click(within(filters).getByRole('button', { name: /^Отказ модели \(1\)$/ }));
    expect(screen.queryByText('Как дойти до Авачинского?')).toBeNull();
    expect(screen.getByText('что взять в поход')).toBeTruthy();
  });

  it('окно меняется кнопкой и уходит в запрос', async () => {
    respond(data([parseOutcomeCase(row({}))]));
    render(<KuzmichOutcomesClient />);
    await screen.findByText('Как дойти до Авачинского?');
    fireEvent.click(screen.getByRole('button', { name: '30 дн.' }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/kuzmich-outcomes?days=30'));
  });

  it('оценок нет вовсе — «судья не писал», а не «всё хорошо»', async () => {
    respond(data([], 0));
    render(<KuzmichOutcomesClient />);
    expect(await screen.findByText(/судья не писал/)).toBeTruthy();
  });

  it('оценки есть, плохих нет — так и сказано', async () => {
    respond(data([], 12));
    render(<KuzmichOutcomesClient />);
    expect(await screen.findByText('Плохих оценок за это окно нет.')).toBeTruthy();
  });

  it('отказ сервера — «не загрузились», а не пустой список', async () => {
    respond({ success: false, error: 'Оценки не прочитались, попробуйте позже.' }, 503);
    render(<KuzmichOutcomesClient />);
    expect((await screen.findByRole('alert')).textContent).toContain('не загрузились');
    expect(screen.queryByText('Плохих оценок за это окно нет.')).toBeNull();
  });

  it('кнопка копирует показанные случаи текстом для разбора', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const cases = [parseOutcomeCase(row({})), parseOutcomeCase(REFUSAL)];
    respond(data(cases));
    render(<KuzmichOutcomesClient />);
    await screen.findByText('Как дойти до Авачинского?');
    fireEvent.click(screen.getByRole('button', { name: /Скопировать показанные/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(casesForReview(cases)));
    expect((await screen.findByRole('status')).textContent).toBe('Скопировано случаев: 2');
  });
});

describe('связка', () => {
  it('экран есть в меню админки', () => {
    const layout = readFileSync(join(ROOT, 'app/hub/admin/layout.tsx'), 'utf8');
    expect(layout).toMatch(/href: '\/hub\/admin\/kuzmich-outcomes'/);
  });

  it('свод в публичном issue ведёт на экран и сам случаев не печатает', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/kuzmich-bad-outcomes-digest.yml'), 'utf8');
    expect(wf).toContain('https://vedarai.ru/hub/admin/kuzmich-outcomes');
    expect(wf).not.toMatch(/compiled_truth|\['question'\]|\['answer'\]/);
  });
});
