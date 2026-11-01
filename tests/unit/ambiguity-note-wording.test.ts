import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
import { ambiguityNote, type TourCandidate } from '@/lib/kuzmich/tour-availability-tool';

const c = (id: number, op: string, name: string | null): TourCandidate => ({
  id, title: `Тур ${id}`, operator_id: op, base_price: 1, price_unit: 'per_person',
  operator_name: name, main_place_id: null, place: null, nearest_free_date: null,
});

describe('неоднозначность — по-русски (01.11)', () => {
  it('одна компания: «3 тура компании «X»», не «туры 1 компании»', () => {
    const t = ambiguityNote('рыбалка', [c(4, 'a', 'Камчатская рыбалка'), c(36, 'a', 'Камчатская рыбалка'), c(37, 'a', 'Камчатская рыбалка')]);
    expect(t).toMatch(/^По запросу «рыбалка» подходят 3 тура компании «Камчатская рыбалка»: ID4/);
    expect(t).not.toMatch(/1 компании/);
    expect(t).toMatch(/не выбирай тур за него/);
  });
  it('имя не записано — «одной компании»; пять — «туров»', () => {
    const t = ambiguityNote('x', [1, 2, 3, 4, 5].map((i) => c(i, 'a', null)));
    expect(t).toMatch(/подходят 5 туров одной компании:/);
  });
  it('разные компании: «туры 2 компаний»', () => {
    const t = ambiguityNote('x', [c(1, 'a', 'A'), c(2, 'b', 'B')]);
    expect(t).toMatch(/подходят туры 2 компаний:/);
    expect(t).toMatch(/не выбирай компанию за него/);
  });
});
