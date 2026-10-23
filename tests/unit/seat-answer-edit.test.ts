/** Правка сообщения запроса мест после ответа в MAX (пилот «Камчатская рыбалка», 23.10). */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
import { pool } from '@/lib/db-pool';
import {
  afterAnswerButtons, answeredEditText, isNextCommand, nextRequestCard, readNextPending,
  NEXT_BUTTON_TEXT, SUMMARY_BUTTON_TEXT,
} from '@/lib/seat-requests/answer-edit';
import { isSummaryCommand } from '@/lib/seat-requests/summary';

const ID = '0aaa4f05-b479-418b-9d54-2b909783dfd7';

describe('кнопки после ответа', () => {
  it('две кнопки message, без кнопок ответа', () => {
    const b = afterAnswerButtons().flat();
    expect(b).toEqual([{ type: 'message', text: 'Сводка' }, { type: 'message', text: 'Следующая заявка' }]);
  });
  it('текст кнопок узнаётся командами', () => {
    expect(isSummaryCommand(SUMMARY_BUTTON_TEXT)).toBe(true);
    expect(isNextCommand(NEXT_BUTTON_TEXT)).toBe(true);
    for (const t of ['/следующая', 'следующая', '/next']) expect(isNextCommand(t)).toBe(true);
    for (const t of ['следующая неделя', 'дай заявку', '']) expect(isNextCommand(t)).toBe(false);
  });
});

describe('текст правки', () => {
  it('исходный текст экранирован, ответ добавлен', () => {
    const t = answeredEditText('Запрос мест\n«A & B», 2026-06-14', 'Принято: мест нет.');
    expect(t).toBe('Запрос мест\n«A &amp; B», 2026-06-14\n\n✓ Ответ дан: Принято: мест нет.');
  });
  it('без исходного текста и в пределах 4000', () => {
    expect(answeredEditText(null, 'ок')).toBe('✓ Ответ дан: ок');
    expect(answeredEditText('x'.repeat(5000), 'ок').length).toBeLessThanOrEqual(4000);
  });
});

describe('следующая заявка', () => {
  it('карточка с кнопками ответа и ссылкой', () => {
    const c = nextRequestCard({ id: ID, title: 'Рыбалка <1>', tourDate: '2026-06-14', participants: 3, deadlineAt: new Date('2026-06-01T00:00:00Z') }, 'https://x/a');
    expect(c.text).toContain('«Рыбалка &lt;1&gt;», 2026-06-14, 3 чел.');
    expect(c.text).toContain('Ответ до 12:00');
    expect(c.buttons[0]!.map((b) => 'payload' in b && b.payload)).toEqual([`sr:y:${ID}`, `sr:n:${ID}`]);
    expect(c.buttons[1]![0]).toMatchObject({ type: 'link', url: 'https://x/a' });
    expect(nextRequestCard({ id: ID, title: 't', tourDate: 'd', participants: 1, deadlineAt: new Date() }, null).buttons).toHaveLength(1);
  });
  it('чтение: нет, есть, ошибка базы', async () => {
    const q = vi.mocked(pool.query);
    q.mockResolvedValueOnce({ rows: [] } as never);
    expect(await readNextPending(ID)).toBeNull();
    q.mockResolvedValueOnce({ rows: [{ id: ID, title: 't', tour_date: '2026-06-14', participants: 2, deadline_at: new Date(0) }] } as never);
    expect(await readNextPending(ID)).toMatchObject({ id: ID, participants: 2 });
    q.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await readNextPending(ID)).toBe('db_error');
  });
});

describe('вебхук', () => {
  const src = readFileSync('app/api/max/kuzmich/route.ts', 'utf8');
  it('правка только пилоту, при неудаче — прежний ответ', () => {
    expect(src).toMatch(/summaryEnabledFor\(lookup\.partner\.partnerId\)\) return false/);
    expect(src).toMatch(/editAnsweredRequest\([^)]*\)\)\s*\{\s*return;\s*\}\s*await maxReply\(chatId, reply\)/);
  });
});
