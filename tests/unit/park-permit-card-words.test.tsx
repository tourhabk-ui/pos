// @vitest-environment jsdom
/**
 * Карточка маршрута и ответ агенту говорят о разрешении одними словами
 * (#3302, срез 4) — рендером.
 *
 * Порядок Кроноцкого заповедника и оговорка о парке, ушедшем в федеральное
 * ведение, до этого среза были набраны прямо в разметке блока. Ответу
 * Кузьмича и MCP о том же маршруте пришлось бы набрать их второй раз — и два
 * текста разошлись бы при первой правке. Теперь слова лежат в
 * lib/safety/park-permit, и блок карточки их оттуда берёт.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ParkPermitAction from '@/components/safety/ParkPermitAction';
import { FEDERAL_PERMIT_UNKNOWN_RU, KRONOKI_ORDER_RU, KRONOKI_REQUESTS } from '@/lib/safety/park-permit';
import { routePermitCase, routePermitLines } from '@/lib/parks/route-permit';

const text = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ');

describe('слова о разрешении — одни на карточку и на ответ агенту', () => {
  it('Кроноцкий заповедник: порядок посещения', () => {
    const input = { title: 'Курильское озеро', parkName: 'Южно-Камчатский заказник федерального значения' };
    const { container } = render(<ParkPermitAction {...input} />);
    expect(text(container)).toContain(KRONOKI_ORDER_RU);
    expect(routePermitLines(routePermitCase(input, null)).join('\n')).toContain(KRONOKI_ORDER_RU);
    // Ссылка карточки и адрес в ответе агенту — одна страница заявок.
    expect(container.querySelector(`a[href="${KRONOKI_REQUESTS.url}"]`)).not.toBeNull();
  });

  it('парк в федеральном ведении: «как выдаются разрешения, не объявлено»', () => {
    const input = { title: 'Вулкан Горелый', parkName: 'Южно-Камчатский' };
    const { container } = render(<ParkPermitAction {...input} />);
    expect(text(container)).toContain(FEDERAL_PERMIT_UNKNOWN_RU);
    expect(routePermitLines(routePermitCase(input, null))[0]).toContain(FEDERAL_PERMIT_UNKNOWN_RU);
  });

  it('обычный парк: оговорки о федеральном ведении нет ни там, ни там', () => {
    const input = { title: 'Вилючинский водопад', parkName: 'Природный парк «Вилючинский»' };
    const { container } = render(<ParkPermitAction {...input} />);
    expect(text(container)).not.toContain(FEDERAL_PERMIT_UNKNOWN_RU);
    expect(routePermitLines(routePermitCase(input, { state: 'none' })).join('\n')).not.toContain(FEDERAL_PERMIT_UNKNOWN_RU);
  });
});
