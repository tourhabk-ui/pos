// @vitest-environment node
/**
 * Автопарк прокатчика: только его прайс, без выдуманной цены и без занятости.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { isFleetAsk, runOperatorRentalFleet, RENTAL_FLEET_TOOL } from '@/lib/kuzmich/operator-rental-fleet';
import { containsPattern } from '@/lib/db/like';
import { partnerSystemPrompt } from '@/lib/kuzmich/operator-chat';
import { formatRub } from '@/lib/transfers/charter-format';

const NOW = Date.parse('2026-10-24T00:00:00Z');
const partner = {
  partnerId: 'p-1', partnerName: 'Лагуна Прокат', slug: 'laguna-prokat',
  category: 'transfer', crmCategory: 'transfer' as const, userId: null,
};

beforeEach(() => {
  query.mockReset();
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('operator_rental_fleet', () => {
  it('называется так и не обещает занятость', () => {
    expect(RENTAL_FLEET_TOOL.function.name).toBe('operator_rental_fleet');
    expect(RENTAL_FLEET_TOOL.function.description).toMatch(/не возвращает/);
  });

  it('короткий запрос про машины — да, чужая фраза — нет', () => {
    expect(isFleetAsk('покажи машины')).toBe(true);
    expect(isFleetAsk('Автопарк')).toBe(true);
    expect(isFleetAsk('прайс')).toBe(true);
    expect(isFleetAsk('какие туры открыты')).toBe(false);
    expect(isFleetAsk('покажи машины и ещё длинный рассказ про поездку на вулкан завтра утром')).toBe(false);
  });

  it('строка прайса: цена за сутки, залог или «не записан», видимость; чужой партнёр в запрос не попадает', async () => {
    query.mockResolvedValue({ rows: [
      { title: 'Suzuki Jimny', body_kind: 'suv', price_rub_per_day: 7000, price_is_from: false, deposit_rub: 15000, is_active: true, driver: 'self' },
      { title: 'Tank-300', body_kind: 'suv', price_rub_per_day: 25000, price_is_from: true, deposit_rub: null, is_active: false, driver: 'optional' },
    ] });
    const out = await runOperatorRentalFleet('p-laguna', 'Лагуна Прокат', 'laguna-prokat', {}, NOW);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/partner_id = \$1::uuid/);
    expect(sql).not.toMatch(/is_active\s*=\s*true/);
    expect(params[0]).toBe('p-laguna');
    expect(out).toContain('Suzuki Jimny');
    expect(out).toContain(`${formatRub(7000)}/сутки`);
    expect(out).toContain(`залог ${formatRub(15000)}`);
    expect(out).toContain('в прайсе');
    expect(out).toContain(`от ${formatRub(25000)}/сутки`);
    expect(out).toContain('залог не записан');
    expect(out).toContain('скрыта из прайса');
    expect(out).toContain('Итоговой суммы');
    expect(out).toContain('скрыт');
    expect(out).not.toMatch(/свободна|занята/);
  });

  it('название и имя из базы экранируются: канал шлёт HTML', async () => {
    query.mockResolvedValue({ rows: [
      { title: 'Jimny <b>', body_kind: 'suv', price_rub_per_day: 7000, price_is_from: false, deposit_rub: null, is_active: true, driver: 'self' },
    ] });
    const out = await runOperatorRentalFleet('p-1', 'Лагуна & Ко', 'laguna-prokat', {}, NOW);
    expect(out).toContain('Jimny &lt;b&gt;');
    expect(out).toContain('Лагуна &amp; Ко');
    expect(out).not.toContain('Jimny <b>');
  });

  it('поиск по названию экранирует шаблон; пустой прайс — не отказ базы', async () => {
    query.mockResolvedValue({ rows: [] });
    const out = await runOperatorRentalFleet('p-1', 'Лагуна', 'laguna-prokat', { car: '100%' }, NOW);
    expect(query.mock.calls[0][1][2]).toBe(containsPattern('100%'));
    expect(out).toContain('нет машины');
    expect(out).not.toContain('НЕ УДАЛОСЬ');
  });

  it('отказ базы — «не удалось», а не «машин нет»', async () => {
    query.mockRejectedValue(Object.assign(new Error('x'), { code: '57P01' }));
    const out = await runOperatorRentalFleet('p-1', 'Лагуна', 'laguna-prokat', {}, NOW);
    expect(out).toContain('НЕ УДАЛОСЬ');
    expect(out).not.toContain('нет ни одной');
  });

  it('инструмент в подсказке только у пилота', () => {
    expect(partnerSystemPrompt(partner, NOW, true)).toMatch(/operator_rental_fleet/);
    expect(partnerSystemPrompt({ ...partner, slug: 'fishing' }, NOW, true)).not.toMatch(/operator_rental_fleet/);
    expect(partnerSystemPrompt({ ...partner, slug: null }, NOW, true)).not.toMatch(/operator_rental_fleet/);
  });
});
