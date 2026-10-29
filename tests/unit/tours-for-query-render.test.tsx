/**
 * «Туры по запросу» на /routes — три исхода, проверенные рендером (П7).
 *
 * Сторож search-finds-tours читает исходник страницы; здесь — что каждый
 * исход действительно рисует своё: отказ поиска туров не выдаётся за «туров
 * нет», пустота не выдаётся за отказ (§4.0).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';

import { ToursForQuery, TOURS_FOR_QUERY_ORDER_NOTE } from '@/components/search/ToursForQuery';

afterEach(cleanup);

describe('ToursForQuery', () => {
  it('unavailable — «не ищутся», а не «не нашлось»', () => {
    const { container } = render(<ToursForQuery q="рыбалка" state={{ status: 'unavailable' }} />);
    expect(container.querySelector('[data-tours-for-query="unavailable"]')).not.toBeNull();
    expect(container.textContent).toMatch(/не ищутся/);
    expect(container.textContent).not.toMatch(/не нашлось/);
  });

  it('ok без туров — «не нашлось», а не отказ', () => {
    const { container } = render(<ToursForQuery q="zzzz" state={{ status: 'ok', tours: [] }} />);
    expect(container.querySelector('[data-tours-for-query="empty"]')).not.toBeNull();
    expect(container.textContent).toMatch(/не нашлось/);
    expect(container.textContent).not.toMatch(/не ищутся/);
  });

  it('ok с турами — ссылка на карточку тура и цена «от»', () => {
    const { container } = render(
      <ToursForQuery
        q="рыбалка"
        state={{ status: 'ok', tours: [{ id: 27, title: 'Рыбалка на Быстрой', operator_name: 'Оператор', activity_type: 'fishing', base_price: 13000 }] }}
      />,
    );
    expect(container.querySelector('[data-tours-for-query="ok"]')).not.toBeNull();
    expect(container.querySelector('a[href="/catalog/tours/27"]')).not.toBeNull();
    expect(container.textContent).toMatch(/от\s*13[\s  ]?000/);
  });

  it('значок строки — по типу активности: джип-тур узнаётся машиной, а не билетом (владелец 12.10)', () => {
    const { container } = render(
      <ToursForQuery
        q="озеро толмач"
        state={{ status: 'ok', tours: [
          { id: 60, slug: 'mestechko-ozero-tolmachevo', title: 'Озеро Толмачёва', operator_name: 'Местечко Камчатка', activity_type: 'jeep_safari', base_price: 14000 },
          { id: 1, title: 'Неизвестный тип', operator_name: null, activity_type: 'zzz', base_price: null },
        ] }}
      />,
    );
    expect(container.querySelector('svg.lucide-car')).not.toBeNull();
    // Неизвестный тип — общий значок, а не пустое место.
    expect(container.querySelectorAll('svg.lucide-ticket')).toHaveLength(1);
  });

  // Ревью 29.10: блок режет выдачу до девяти туров, и какие попали, решает
  // правило 1в — завтра другие. Правило и «N из M» названы на месте (§0).
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: 400 + i, title: `Тур ${i}`, operator_name: `Компания ${i}`, activity_type: 'fishing', base_price: 10000 }));

  it('обрезанная выдача — «Показано 9 из 20 туров» и правило с группами, кончается «Место в списке не продаётся.»', () => {
    const { container, getByText } = render(<ToursForQuery q="вулкан" state={{ status: 'ok', tours: nine, total: 20 }} />);
    expect(container.textContent).toContain('Показано 9 из 20 туров — остальные в каталоге.');
    expect(getByText(TOURS_FOR_QUERY_ORDER_NOTE).textContent).toMatch(/Место в списке не продаётся\.$/);
    expect(TOURS_FOR_QUERY_ORDER_NOTE).toMatch(/совпавшие названием/);
    // Подпись — до списка туров, а не после.
    const note = container.querySelector('[data-tours-for-query-note]')!;
    const list = container.querySelector('ul')!;
    expect(note.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('все показаны — без «из M»; точного числа нет — так и сказано, а не заниженная цифра', () => {
    const all = render(<ToursForQuery q="вулкан" state={{ status: 'ok', tours: nine.slice(0, 3), total: 3 }} />);
    expect(all.container.textContent).not.toMatch(/Показано/);
    expect(all.container.textContent).toContain('Место в списке не продаётся.');
    cleanup();
    const unknown = render(<ToursForQuery q="вулкан" state={{ status: 'ok', tours: nine, total: null }} />);
    expect(unknown.container.textContent).toContain('здесь не посчитано');
    cleanup();
    const one = render(<ToursForQuery q="вулкан" state={{ status: 'ok', tours: nine.slice(0, 1), total: 1 }} />);
    expect(one.container.querySelector('[data-tours-for-query-note]')).toBeNull();
  });
});
