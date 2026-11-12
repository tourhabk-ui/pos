// @vitest-environment jsdom
/**
 * Карточка вердикта маршрута — рендером (12.11, #3302).
 *
 * Слова фактов переехали из компонента в lib/routes/verdict-facts, чтобы
 * карточка и ответ Кузьмича и MCP о маршруте говорили одним текстом. Здесь
 * судится то, что видит человек на карточке после переезда: слово, причина,
 * строки «что проверено» и оговорка — и что «не смогли узнать» не подменено
 * пустым списком.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import RouteVerdict, { type VerdictResponse } from '@/components/routes/RouteVerdict';
import { goVerdict, VERDICT_LABELS, type RouteSignals } from '@/lib/routes/go-verdict';
import { VERDICT_DISCLAIMER_RU } from '@/lib/routes/verdict-facts';

function response(signals: RouteSignals): VerdictResponse {
  const verdict = goVerdict(signals);
  return { verdict: { ...verdict, label: VERDICT_LABELS[verdict.status] }, signals };
}

const base: RouteSignals = { alerts: [], volcanoes: [], inSeason: null, weather: null, closures: [] };

describe('карточка вердикта маршрута', () => {
  it('запрет: слово, причина, факты и оговорка', () => {
    render(<RouteVerdict routeId="r1" data={response({
      ...base,
      alerts: [{ title: 'Закрыты маршруты природного парка «Вилючинский»', severity: 2, type: 'park_closure', zonal: false }],
      volcanoes: [{ name: 'Мутновский', acc: 'yellow' }],
      inSeason: false,
    })} />);
    const block = screen.getByRole('region', { name: 'Вердикт на сегодня' });
    expect(within(block).getByText('Не сегодня')).toBeTruthy();
    expect(within(block).getByText('МЧС: Закрыты маршруты природного парка «Вилючинский»')).toBeTruthy();
    expect(block.textContent).toContain('Предупреждения:Закрыты маршруты природного парка «Вилючинский»');
    expect(block.textContent).toContain('Вулканы на маршруте:Мутновский — жёлтый');
    expect(block.textContent).toContain('Закрытые точки:администратор не отмечал');
    expect(block.textContent).toContain('Сезон:маршрут вне сезона');
    expect(block.textContent).toContain(VERDICT_DISCLAIMER_RU);
  });

  it('незнание названо словами, а не выглядит пустым списком', () => {
    render(<RouteVerdict routeId="r1" data={response({ ...base, alerts: null, volcanoes: null, closures: null })} />);
    const block = screen.getByRole('region', { name: 'Вердикт на сегодня' });
    expect(within(block).getByText('Осторожно')).toBeTruthy();
    expect(within(block).getAllByText('не смогли узнать')).toHaveLength(3);
    expect(block.textContent).not.toContain('действующих нет');
  });

  it('спокойный день: «Идти», факты под раскрытием, оговорки о бюллетене нет', () => {
    render(<RouteVerdict routeId="r1" data={response(base)} />);
    const block = screen.getByRole('region', { name: 'Вердикт на сегодня' });
    expect(within(block).getByText('Идти')).toBeTruthy();
    expect(block.textContent).toContain('Предупреждения:действующих нет');
    expect(block.textContent).toContain('Вулканы на маршруте:в 25 км нет');
    expect(block.textContent).not.toContain(VERDICT_DISCLAIMER_RU);
  });
});
