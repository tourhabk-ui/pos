/**
 * Статус «открыт / закрыт» утверждённых маршрутов природных парков (слово
 * владельца 20.11: «Статус открыт/закрыт», «Шкала как у KVERT»).
 *
 * Держит связку целиком: разбор страницы парка → статус маршрута по
 * вариантам → цвет по шкале KVERT → оценка дня (оранжевый — «Осторожно»,
 * красный — «Не сегодня», не проверено — «данных мало») → строки фактов
 * (карточка, Кузьмич, MCP) и вариант на карточке → роут чтения с тремя
 * исходами. Запись на настоящем PostgreSQL — tests/integration/park-routes.pg.test.ts.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parseParkRoutesPage, routeParkStatus } from '@/lib/parks/park-route-status';
import { goVerdict, parkRouteColor, type RouteSignals } from '@/lib/routes/go-verdict';
import { verdictFactLines } from '@/lib/routes/verdict-facts';
import { approvedRouteLines, variantStatusWords, type ApprovedVariant } from '@/lib/parks/approved-routes-words';
import { ParkApprovedRoute } from '@/components/routes/ParkApprovedRoute';
import { runParkStatusRead, type QueryFn } from '@/lib/parks/park-route-status-run';

const HEAD = '<tr><td>Название</td><td>Статус</td><td>Сезон</td><td>Период</td><td>Способ передвижения</td><td>Паспорт</td><td>GPS-трек</td></tr>';
const cells = (...c: string[]) => `<tr>${c.map((x) => `<td>${x}</td>`).join('')}</tr>`;

/** Разметка как на странице парка: подпись парка, rowspan у названия, сущности. */
const PAGE = `
  <p><strong>Природный парк &laquo;Налычево&raquo;</strong></p>
  <table>${HEAD}
    <tr><td rowspan="2"><span><strong>Пиначево &nbsp; &mdash; Центральный</strong></span></td><td><span>закрыт</span><br /></td><td>лето</td><td>июнь-октябрь</td><td>Пешком</td><td><a href="p.pdf">Скачать</a></td><td><a href="t.zip">Скачать</a></td></tr>
    ${cells('открыт', 'зима', 'декабрь-май', 'На лыжах', 'Скачать', 'Скачать')}
  </table>
  <h3>Природный парк «Вилючинский»</h3>
  <table>${HEAD}
    ${cells('Восхождение на вулкан Вилючинский', 'закрыт', 'лето\\зима', 'всесезонный', 'На лыжах', '', '')}
    ${cells('Странный маршрут', 'на ремонте', 'лето', '', '', '', '')}
  </table>`;

describe('разбор страницы парка', () => {
  it('строки варианта: парк по подписи, название из rowspan, сезон и статус словами страницы', () => {
    const { rows, problems } = parseParkRoutesPage(PAGE);
    expect(rows).toEqual([
      { parkSlug: 'nalychevo', title: 'Пиначево — Центральный', season: 'summer', status: 'closed' },
      { parkSlug: 'nalychevo', title: 'Пиначево — Центральный', season: 'winter', status: 'open' },
      { parkSlug: 'vilyuchinsky', title: 'Восхождение на вулкан Вилючинский', season: 'all', status: 'closed' },
    ]);
    // Неизвестное слово статуса не угадывается — уходит в problems.
    expect(problems).toEqual(['vilyuchinsky: «Странный маршрут» — статус «на ремонте» не распознан']);
  });

  it('таблица без известного парка и строка с чужим числом ячеек — названы, не угаданы', () => {
    const page = `<p>Природный парк «Новый»</p><table>${HEAD}${cells('А', 'открыт', 'лето', '', '', '', '')}</table>
      <p>Природный парк «Налычево»</p><table>${HEAD}${cells('Б', 'открыт', 'лето', '', '', '', '')}<tr><td>лишнее</td></tr></table>`;
    const { rows, problems } = parseParkRoutesPage(page);
    expect(rows).toEqual([{ parkSlug: 'nalychevo', title: 'Б', season: 'summer', status: 'open' }]);
    expect(problems).toEqual([
      'таблица маршрутов без известного парка: «Новый»',
      'nalychevo: строка из 1 ячеек после «Б»',
    ]);
  });

  it('таблицы не о маршрутах пропускаются', () => {
    expect(parseParkRoutesPage('<table><tr><td>Контакты</td></tr></table>')).toEqual({ rows: [], problems: [] });
  });
});

describe('статус маршрута по вариантам', () => {
  it('хоть один свежий «открыт» — открыт; все свежие «закрыт» — закрыт', () => {
    expect(routeParkStatus([{ status: 'closed', fresh: true }, { status: 'open', fresh: true }])).toBe('open');
    expect(routeParkStatus([{ status: 'closed', fresh: true }, { status: 'closed', fresh: true }])).toBe('closed');
  });
  it('непрочитанный или устаревший вариант без открытого — не проверено', () => {
    expect(routeParkStatus([{ status: 'closed', fresh: true }, { status: null, fresh: false }])).toBeNull();
    expect(routeParkStatus([{ status: 'open', fresh: false }])).toBeNull();
    expect(routeParkStatus([])).toBeNull();
  });
});

const BASE: RouteSignals = { alerts: [], volcanoes: [], inSeason: true, weather: null, closures: [] };
const ERUPTION = { title: 'Извержение: пепел на перевале', severity: 1, type: 'volcanic_eruption', zonal: false };
const SEASON_CLOSURE = { title: 'Закрытие маршрутов парка на межсезонье', severity: 1, type: 'park_closure', zonal: false };

describe('цвет по шкале KVERT', () => {
  it('открыт: без предупреждений — зелёный, с предупреждением — жёлтый', () => {
    expect(parkRouteColor('open', [])).toBe('green');
    expect(parkRouteColor('open', [SEASON_CLOSURE])).toBe('yellow');
  });
  it('закрыт: опасность не названа — оранжевый, названа — красный', () => {
    expect(parkRouteColor('closed', [])).toBe('orange');
    // Само закрытие парка — не причина, а оно же: оранжевый.
    expect(parkRouteColor('closed', [SEASON_CLOSURE])).toBe('orange');
    expect(parkRouteColor('closed', [ERUPTION])).toBe('red');
    // Зональная единица оценку не поднимает (#3334) — и цвет тоже.
    expect(parkRouteColor('closed', [{ ...ERUPTION, zonal: true }])).toBe('orange');
  });
  it('незнание зелёного не даёт', () => {
    expect(parkRouteColor(null, [])).toBeNull();
    expect(parkRouteColor('open', null)).toBeNull();
  });
});

describe('оценка дня', () => {
  const park = (status: 'open' | 'closed') => ({ status, title: 'Пиначево — Центральный', readOn: '2026-11-21' });

  it('оранжевый — «Осторожно» с причиной парка', () => {
    expect(goVerdict({ ...BASE, park: park('closed') })).toMatchObject({
      status: 'caution', code: 'park_closed', reason: 'Парк отмечает маршрут «Пиначево — Центральный» закрытым',
    });
  });
  it('красный — «Не сегодня», хотя предупреждение само запретом не было', () => {
    expect(goVerdict({ ...BASE, alerts: [ERUPTION] }).status).toBe('caution');
    expect(goVerdict({ ...BASE, alerts: [ERUPTION], park: park('closed') })).toMatchObject({
      status: 'no', code: 'park_closed_hazard',
      reason: 'Парк закрыл маршрут «Пиначево — Центральный»: Извержение: пепел на перевале',
    });
  });
  it('не проверено — «данных мало», зелёного нет', () => {
    const v = goVerdict({ ...BASE, park: null });
    expect(v).toMatchObject({ status: 'caution', code: 'signals_unknown' });
    expect(v.unknown).toContain('статус маршрута в парке');
  });
  it('открыт или маршрут не из списка парка — оценка как была', () => {
    expect(goVerdict({ ...BASE, park: park('open') })).toMatchObject({ status: 'go', code: 'clear' });
    expect(goVerdict(BASE)).toMatchObject({ status: 'go', code: 'clear' });
  });
});

describe('строки фактов — карточка, Кузьмич, MCP', () => {
  const line = (s: RouteSignals) => verdictFactLines(s).find((f) => f.label === 'Маршрут в парке');
  it('статус, дата чтения и уровень по шкале', () => {
    expect(line({ ...BASE, park: { status: 'closed', title: 'Пиначево — Центральный', readOn: '2026-11-21' } })).toEqual({
      label: 'Маршрут в парке', value: '«Пиначево — Центральный» — закрыт по странице парка на 21.11 · уровень оранжевый', dim: false,
    });
  });
  it('не проверено — приглушённой строкой; не из списка парка — строки нет', () => {
    expect(line({ ...BASE, park: null })).toEqual({ label: 'Маршрут в парке', value: 'статус на странице парка не проверен', dim: true });
    expect(line(BASE)).toBeUndefined();
  });
});

const VARIANT: ApprovedVariant = {
  parkName: 'Природный парк «Налычево»', title: 'Пиначево — Центральный', season: 'summer', period: 'июнь-октябрь',
  movement: 'Передвижение пешком', passportUrls: [], trackUrl: null,
  sourceUrl: 'https://vulcanikamchatki.ru/v_pomow_gostyu/nomera_marshrutov/', readOn: '2026-11-20',
  status: 'closed', statusReadOn: '2026-11-21',
};

describe('вариант на карточке и в ответе агента', () => {
  it('статус словами; без чтения — «не проверен», а не «открыт»', () => {
    expect(variantStatusWords(VARIANT)).toBe('сейчас закрыт (по странице парка на 21.11.2026)');
    expect(variantStatusWords({ status: null, statusReadOn: null })).toBe('статус на странице парка не проверен');
  });
  it('строки Кузьмича и MCP несут статус варианта', () => {
    expect(approvedRouteLines({ kind: 'linked', variants: [VARIANT] })[0]).toContain('сейчас закрыт (по странице парка на 21.11.2026)');
  });
  it('карточка: у каждого варианта свой статус', () => {
    render(<ParkApprovedRoute approved={{ kind: 'linked', variants: [VARIANT, { ...VARIANT, season: 'winter', status: null, statusReadOn: null }] }} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-park-status'))).toEqual(['closed', 'unknown']);
    expect(items[0]!.textContent).toContain('сейчас закрыт (по странице парка на 21.11.2026)');
    expect(items[1]!.textContent).toContain('статус на странице парка не проверен');
    expect(screen.queryByText(/уточняйте у парка/)).toBeNull();
  });
});

describe('прогон чтения: три исхода', () => {
  const q = (written: Array<{ park_slug: string; title: string; season: string }>, all = written): QueryFn =>
    (async (sql: string) => ({ rows: sql.includes('UPDATE') ? written : all })) as QueryFn;

  it('страница не ответила — ничего не пишется', async () => {
    const query = vi.fn();
    expect(await runParkStatusRead({ query: query as never, fetchHtml: async () => ({ error: 'HTTP 503' }) }))
      .toEqual({ outcome: 'fetch_failed', error: 'HTTP 503' });
    expect(query).not.toHaveBeenCalled();
  });
  it('строк статуса нет — отказ, а не «маршрутов нет»', async () => {
    expect(await runParkStatusRead({ query: q([]), fetchHtml: async () => ({ html: '<p>Сайт на обслуживании</p>' }) }))
      .toMatchObject({ outcome: 'parse_empty' });
  });
  it('прочитано — записанные, открытые и несовпавшие названы', async () => {
    const pin = { park_slug: 'nalychevo', title: 'Пиначево — Центральный' };
    const run = await runParkStatusRead({
      query: q([{ ...pin, season: 'summer' }, { ...pin, season: 'winter' }],
        [{ ...pin, season: 'summer' }, { ...pin, season: 'winter' }, { park_slug: 'nalychevo', title: 'Радыгино — Центральный', season: 'summer' }]),
      fetchHtml: async () => ({ html: PAGE }),
    });
    expect(run).toEqual({
      outcome: 'read', parsed: 3, written: 2,
      open: ['nalychevo · Пиначево — Центральный · winter'],
      not_in_table: ['vilyuchinsky · Восхождение на вулкан Вилючинский · all'],
      not_on_page: ['nalychevo · Радыгино — Центральный · summer'],
      problems: ['vilyuchinsky: «Странный маршрут» — статус «на ремонте» не распознан'],
    });
  });
});
