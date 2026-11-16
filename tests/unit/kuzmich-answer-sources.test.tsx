/**
 * Источники под ответом Кузьмича (#3412, п. 1): строит код из вывода
 * инструментов хода, модель их не пишет. Правило — вызовом, блок — рендером.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { toolSource, answerSources, SOURCE_TOOL_NAMES } from '@/lib/kuzmich/answer-sources';
import { KUZMICH_TOOLS } from '@/lib/kuzmich/tool-schemas';
import AnswerSources from '@/components/kuzmich/AnswerSources';

afterEach(cleanup);

const PLACE_OUT = [
  'Вулкан Горелый — действующий вулкан, 1829 м.',
  'Маршруты: «Подъём на Горелый» (12 км) — https://vedarai.ru/routes/gorely-up',
  'Страница места на сайте «Вулкан Горелый»: https://vedarai.ru/places/gorely.',
].join('\n');

describe('источник одного вызова', () => {
  it('карточка места: главная страница — место, имя из той же строки; маршрут рядом не берётся', () => {
    expect(toolSource('get_place_info', PLACE_OUT)).toEqual({ title: 'Карточка места: Вулкан Горелый', href: '/places/gorely' });
  });

  it('страница без имени — словами инструмента; запрос и якорь срезаны', () => {
    expect(toolSource('get_tour_details', 'Страница тура и заявка оператору: https://vedarai.ru/catalog/tours/gorely-36#booking — заявку подтверждает оператор.'))
      .toEqual({ title: 'Описание тура', href: '/catalog/tours/gorely-36' });
  });

  it('данные без своей страницы — источник без ссылки; чужой сайт и ссылка статуса заявки не берутся', () => {
    expect(toolSource('get_weather', 'Горелый: ветер 5 м/с, +4°.')).toEqual({ title: 'Погода', href: null });
    expect(toolSource('get_place_info', 'См. https://example.com/places/gorely')).toEqual({ title: 'Карточка места', href: null });
    expect(toolSource('get_tour_availability', 'Статус: https://vedarai.ru/request-status#secretkey')).toEqual({ title: 'Свободные места', href: null });
  });

  it('незнакомый инструмент — не источник', () => {
    expect(toolSource('search_taaft', 'Приложение X')).toBeNull();
    expect(toolSource('нечто_новое', 'данные')).toBeNull();
  });

  it('у инструментов Кузьмича про Камчатку источник назван (сторонний каталог приложений — нет)', () => {
    const missing = KUZMICH_TOOLS.map((t) => t.function.name).filter((n) => !SOURCE_TOOL_NAMES.has(n) && n !== 'search_taaft');
    expect(missing).toEqual([]);
  });
});

describe('список источников хода', () => {
  it('по порядку, без повторов, не больше шести; пустые вызовы пропущены', () => {
    const weather = { title: 'Погода', href: null };
    const place = { title: 'Карточка места: Вулкан Горелый', href: '/places/gorely' };
    expect(answerSources([weather, null, place, weather, undefined])).toEqual([weather, place]);
    const many = Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, href: null }));
    expect(answerSources(many)).toHaveLength(6);
  });
});

describe('блок под ответом', () => {
  it('страница — ссылкой, данные без страницы — словами', () => {
    const { container } = render(<AnswerSources sources={[
      { title: 'Карточка места: Вулкан Горелый', href: '/places/gorely' },
      { title: 'Погода', href: null },
    ]} />);
    expect(container.textContent).toBe('Источники: Карточка места: Вулкан Горелый · Погода');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/places/gorely');
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('источников нет — блока нет', () => {
    expect(render(<AnswerSources sources={[]} />).container.innerHTML).toBe('');
  });
});
