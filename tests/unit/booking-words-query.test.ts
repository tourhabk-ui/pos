import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() } }));
import { bookingWordsQuery } from '@/lib/kuzmich/core';

describe('слова тура из реплики брони (экзамен 01.11)', () => {
  it('убирает слова просьбы и числа, оставляет слова тура', () => {
    expect(bookingWordsQuery('хочу забронировать зимнюю рыбалку ноябрь январь')).toBe('зимнюю рыбалку ноябрь январь');
    expect(bookingWordsQuery('оформи заявку на Курильское озеро 15 июля, нас 3')).toBe('курильское озеро июля');
  });
  it('не режет слова на «в»/«с»/«на»', () => {
    expect(bookingWordsQuery('хочу на вулкан Авачинский')).toBe('вулкан авачинский');
    expect(bookingWordsQuery('сплав по реке')).toBe('сплав реке');
  });
  it('одно слово — пусто: дело ключей вида отдыха', () => {
    expect(bookingWordsQuery('хочу забронировать рыбалку')).toBe('');
  });
});
