/**
 * Блок «Экология и охрана природы» говорит только записанное у места (15.10).
 *
 * До этого дня у блока был «Экологический календарь» — один шаблон на режим
 * охраны, без источника, — и запасные «Правила посещения» по режиму, когда у
 * места своих правил нет. Разбор показал выдумку о конкретных местах:
 * «зимой часть маршрутов закрыта» у заповедника без маршрутов, «в нерест вход
 * только с инспектором» у заказника, где правило другое, «лицензированный
 * гид», «до 900 °C». Обязательному полю, которому нечем быть, остаётся только
 * врать (§4.0). Судится рендером: что видит человек.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PlaceEco from '@/components/places/PlaceEco';

afterEach(cleanup);

const ZONES = ['UNESCO', 'federal_reserve', 'national_park', 'natural_park', 'zakaznik', 'nature_monument', 'regional_reserve'];
const TEMPLATE_CLAIMS = [
  /Экологический календарь/,
  /Нерест/,
  /инспектор/,
  /лицензирован/,
  /900\s*°?C/,
  /бронируйте заранее/,
  /Зимн(ее|ий) (закрытие|период)/,
  /Лучший сезон/,
  /Гнездов/,
];

describe('экоблок места без шаблона', () => {
  it.each(ZONES)('%s без записанных правил: ни календаря, ни шаблонных правил — честное «не записаны»', (zone) => {
    const { container } = render(
      <PlaceEco eco={{ zone, permitRequired: null, rules: null, permitUrl: null }} placeName="Место" />,
    );
    const text = container.textContent ?? '';
    for (const claim of TEMPLATE_CLAIMS) expect(text, `${zone}: ${claim}`).not.toMatch(claim);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(text).toMatch(/Правила посещения этого места на платформе пока не записаны/);
  });

  it('записанные правила места показываются как есть, без объяснения «не записаны»', () => {
    render(
      <PlaceEco
        eco={{ zone: 'zakaznik', permitRequired: true, rules: 'Посещение — по заявке и разрешению заповедника\nКостры — только в отведённых местах', permitUrl: 'https://kronoki.ru/ru/visit/requests/' }}
        placeName="Курильское озеро"
      />,
    );
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Посещение — по заявке и разрешению заповедника',
      'Костры — только в отведённых местах',
    ]);
    expect(document.body.textContent).not.toMatch(/не записаны/);
    expect(screen.getByRole('link', { name: 'Как получить разрешение' }).getAttribute('href')).toBe('https://kronoki.ru/ru/visit/requests/');
  });
});
