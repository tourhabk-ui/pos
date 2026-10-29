// @vitest-environment jsdom
/**
 * Прогноз Камчатского УГМС (lib/weather/ugms-forecast) — разбор страниц
 * kammeteo.ru на образце пробы 1015 (29.10), район по точке, чтение из базы
 * тремя исходами, строки для Кузьмича и блок на /weather рендером.
 *
 * Правило §4.0: граница южных и северных районов в прогнозе не названа —
 * место между ними получает оба блока, а не догадку; «прогноза нет у нас»
 * не выдаётся за «погода спокойная»; отказ базы — «сбой», не пустота.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

import {
  parseUgmsPage, ugmsDate, ugmsLines, ugmsZonesForPoint, loadUgmsForecast, syncUgmsForecast,
  ugmsLinesForKuzmich, UGMS_DAY1_URL, UGMS_DAY23_URL, type UgmsRead,
} from '@/lib/weather/ugms-forecast';
import { UgmsForecast } from '@/components/weather/UgmsForecast';

/** Страница на сутки — как отдаёт kammeteo.ru (текст пробы 1015, обёрнутый в разметку сайта). */
const DAY1_HTML = `<html><head><title>Камчатгидромет - погода на Камчатке</title></head><body>
<table><tr><td class="menu"><a href="/">на главную</a><br>Об учреждении<br>О погоде<br>прогнозы</td>
<td class="td2"><p><b>Прогноз погоды</b></p>
<p><a href="prognozy1.php">Прогноз погоды на ближайшие сутки</a><br><a href="prognozy2.php">Прогноз погоды на 2-3 сутки</a></p>
<p><b>ПРОГНОЗ НА 30 октября</b></p>
<p><b>ПЕТРОПАВЛОВСК-КАМЧАТСКИЙ</b></p>
<p>Переменная облачность, преимущественно без осадков. Ветер западный ночью сильный, днем умеренный. Температура воздуха ночью около 0, днем +3,+5&deg;С.</p>
<p><b>ЮЖНЫЕ РАЙОНЫ КАМЧАТСКОГО КРАЯ</b></p>
<p>Облачно с прояснениями, местами небольшой, днем в западных районах умеренный снег. Ветер северо-западный умеренный, в прибрежных районах местами сильный. Температура воздуха ночью -4,+1, в центральной части -8,-13, днем +2,+7, в горных районах -4,+1&deg;С.</p>
<p><b>СЕВЕРНЫЕ РАЙОНЫ КАМЧАТСКОГО КРАЯ</b></p>
<p>Облачно с прояснениями, преимущественно без осадков, в Тигильском МО небольшой, местами умеренный снег. Ветер северный умеренный, местами сильный. Температура воздуха ночью -2,-7, на севере -12,-17, днем -3,+2, в отдельных районах -3,-8&deg;С.</p>
</td></tr></table>
<div class="footer">Наши координаты<br>Факс: 8-(4152)-29-83-63<br>E-mail: priem@kammeteo.ru</div>
<script>var x = 1;</script></body></html>`;

const DAY23_HTML = `<html><body><td>
<p><b>ПРОГНОЗ НА 31 октября-01 ноября</b></p>
<p><b>ЮЖНЫЕ РАЙОНЫ КАМЧАТСКОГО КРАЯ</b></p>
<p>31 октября Облачная погода с прояснениями, местами снег, днем с дождем, от небольшого до умеренного. Ветер ночью северо-западный, днем юго-восточный умеренный. Температура воздуха ночью -3,-8, днем +1,+6&deg;С.</p>
<p>01 ноября Облачная погода, осадки, днем местами сильные. Ветер юго-восточный умеренный, в прибрежных районах местами сильный. Температура воздуха ночью +1,-4, днем +1,+6&deg;С.</p>
<p>На дорогах гололедица</p>
<p><b>СЕВЕРНЫЕ РАЙОНЫ КАМЧАТСКОГО КРАЯ</b></p>
<p>31 октября Облачная погода с прояснениями, преимущественно без осадков. Ветер западный умеренный. Температура воздуха ночью -3,-8, днем +1,-4&deg;С.</p>
<p>01 ноября Облачная погода, небольшой снег. Ветер восточный умеренный. Температура воздуха ночью -3,-8, днем +1,-4&deg;С.</p>
</td><div>на главную</div></body></html>`;

describe('дата из заголовка', () => {
  it('день и месяц словами, год от дня чтения; декабрь→январь через год; несуществующая — null', () => {
    expect(ugmsDate('30 октября', '2026-10-29')).toBe('2026-10-30');
    expect(ugmsDate('01 января', '2026-12-31')).toBe('2027-01-01');
    expect(ugmsDate('31 декабря', '2027-01-01')).toBe('2026-12-31');
    expect(ugmsDate('30 февраля', '2026-02-27')).toBeNull();
    expect(ugmsDate('завтра', '2026-10-29')).toBeNull();
  });
});

describe('разбор страниц', () => {
  it('на сутки: три района, текст дословно, дата из заголовка, подвал и меню не попадают', () => {
    const p = parseUgmsPage(DAY1_HTML, 'day1', '2026-10-29');
    expect(p.problems).toEqual([]);
    expect(p.heading).toBe('ПРОГНОЗ НА 30 октября');
    expect(p.blocks.map((b) => [b.zone, b.date])).toEqual([['city', '2026-10-30'], ['south', '2026-10-30'], ['north', '2026-10-30']]);
    expect(p.blocks[0].text).toBe('Переменная облачность, преимущественно без осадков. Ветер западный ночью сильный, днем умеренный. Температура воздуха ночью около 0, днем +3,+5°С.');
    expect(p.blocks[2].text).toMatch(/^Облачно с прояснениями, преимущественно без осадков, в Тигильском МО/);
    expect(p.blocks[2].text).not.toMatch(/Факс|координаты|var x/);
  });

  it('на 2–3 суток: день из абзаца, заметка блока ко всем его дням, города нет', () => {
    const p = parseUgmsPage(DAY23_HTML, 'day23', '2026-10-29');
    expect(p.problems).toEqual([]);
    expect(p.blocks.map((b) => [b.zone, b.date])).toEqual([
      ['south', '2026-10-31'], ['south', '2026-11-01'], ['north', '2026-10-31'], ['north', '2026-11-01'],
    ]);
    expect(p.blocks[0].text).toMatch(/^Облачная погода с прояснениями, местами снег/);
    expect(p.blocks[0].notes).toEqual(['На дорогах гололедица']);
    expect(p.blocks[1].notes).toEqual(['На дорогах гололедица']);
    expect(p.blocks[2].notes).toEqual([]);
  });

  it('не страница прогноза — ноль блоков и названная причина, не пустой успех', () => {
    const p = parseUgmsPage('<html><body>404 - Файл или каталог не найден.</body></html>', 'day1', '2026-10-29');
    expect(p.blocks).toEqual([]);
    expect(p.problems[0]).toMatch(/заголовок/);
    expect(ugmsLines('<p>a&nbsp;b</p><br>c')).toEqual(['a b', 'c']);
  });
});

describe('район по точке', () => {
  it('город — только сама точка города; юг до 56°, север от 57,5°, между — оба', () => {
    expect(ugmsZonesForPoint(53.02, 158.65)).toEqual(['city']);
    expect(ugmsZonesForPoint(53.255, 158.83)).toEqual(['south']);   // Авачинский — горы, не город
    expect(ugmsZonesForPoint(55.93, 158.70)).toEqual(['south']);    // Эссо — «центральная часть» юга
    expect(ugmsZonesForPoint(56.23, 162.47)).toEqual(['south', 'north']); // Усть-Камчатск — граница не названа
    expect(ugmsZonesForPoint(59.08, 159.97)).toEqual(['north']);    // Палана
  });
});

describe('запись и чтение', () => {
  afterEach(() => { poolQuery.mockReset(); cleanup(); });

  it('sync: обе страницы → по записи на день и район, страница-отказ названа', async () => {
    poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const f = vi.fn(async (url: string) => new Response(url === UGMS_DAY1_URL ? DAY1_HTML : DAY23_HTML, { status: 200 })) as unknown as typeof fetch;
    const r = await syncUgmsForecast(f, new Date('2026-10-29T05:40:00Z'));
    expect(r).toMatchObject({ ok: true, written: 7, pagesRead: 2, problems: [] });
    const inserts = poolQuery.mock.calls.filter(([sql]) => /INSERT INTO ugms_forecasts/.test(String(sql)));
    expect(inserts).toHaveLength(7);
    expect(inserts[0][1]).toEqual(['day1', '2026-10-30', 'city', expect.stringMatching(/^Переменная облачность/), [], UGMS_DAY1_URL, expect.stringMatching(/^[0-9a-f]{64}$/)]);

    poolQuery.mockClear();
    const half = vi.fn(async (url: string) => new Response(url === UGMS_DAY1_URL ? DAY1_HTML : '', { status: url === UGMS_DAY1_URL ? 200 : 503 })) as unknown as typeof fetch;
    const r2 = await syncUgmsForecast(half, new Date('2026-10-29T05:40:00Z'));
    expect(r2).toMatchObject({ ok: true, written: 3, pagesRead: 1 });
    expect(r2.problems[0]).toMatch(/HTTP 503/);
    expect(r2.problems[0]).toContain(UGMS_DAY23_URL);

    const down = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await syncUgmsForecast(down, new Date('2026-10-29T05:40:00Z'))).toMatchObject({ ok: false, written: 0, pagesRead: 0 });
  });

  it('load: на день и район одна запись, суточная страница в приоритете; пусто — ok с пустым списком', async () => {
    poolQuery.mockResolvedValue({ rows: [
      { kind: 'day1', date: '2026-10-30', zone: 'city', text: 'Суточный', notes: [], fetched_at: '2026-10-29T05:40:00Z' },
      { kind: 'day23', date: '2026-10-30', zone: 'city', text: 'Двухсуточный', notes: ['Гололедица'], fetched_at: '2026-10-29T05:40:00Z' },
      { kind: 'day23', date: '2026-10-31', zone: 'city', text: 'Завтра-послезавтра', notes: null, fetched_at: null },
    ] });
    const read = await loadUgmsForecast(53.02, 158.65, new Date('2026-10-29T20:00:00Z'));
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.ambiguous).toBe(false);
    expect(read.items.map((i) => [i.date, i.text, i.notes])).toEqual([['2026-10-30', 'Суточный', []], ['2026-10-31', 'Завтра-послезавтра', []]]);
    // Сегодня по Камчатке (UTC+12): 20:00 UTC 29.10 — уже 30.10.
    expect(poolQuery.mock.calls[0][1]).toEqual([['city'], '2026-10-30']);

    poolQuery.mockResolvedValue({ rows: [] });
    expect(await loadUgmsForecast(56.23, 162.47)).toMatchObject({ kind: 'ok', items: [], ambiguous: true, zones: ['south', 'north'] });
  });

  it('load: отказ базы — failed с причиной и строкой в логе', async () => {
    poolQuery.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadUgmsForecast(53.02, 158.65)).toEqual({ kind: 'failed', reason: 'прогноз УГМС не прочитан из базы' });
    expect(String(err.mock.calls[0])).toContain('42P01');
    err.mockRestore();
  });
});

describe('строки для Кузьмича', () => {
  const ok: UgmsRead = {
    kind: 'ok', zones: ['south'], ambiguous: false,
    items: [{ date: '2026-10-30', zone: 'south', text: 'Облачно, снег.', notes: ['На дорогах гололедица'], fetchedAt: null, kind: 'day1' }],
  };
  it('дословно, с источником, районом и датой; пусто и отказ — названы', () => {
    const lines = ugmsLinesForKuzmich(ok);
    expect(lines[0]).toMatch(/Камчатского УГМС, дословно/);
    expect(lines[1]).toBe('- 30.10, южные районы края: Облачно, снег. На дорогах гололедица.');
    expect(ugmsLinesForKuzmich({ ...ok, items: [], ambiguous: true, zones: ['south', 'north'] })[0]).toMatch(/нет \(не прочитан\).*не значит/);
    expect(ugmsLinesForKuzmich({ kind: 'failed', reason: 'прогноз УГМС не прочитан из базы' })[0]).toMatch(/не выдумывай/);
  });
});

describe('блок на /weather', () => {
  afterEach(cleanup);
  const items: UgmsRead = {
    kind: 'ok', zones: ['south', 'north'], ambiguous: true,
    items: [
      { date: '2026-10-30', zone: 'south', text: 'Юг: снег.', notes: ['На дорогах гололедица'], fetchedAt: '2026-10-29T05:40:00Z', kind: 'day1' },
      { date: '2026-10-30', zone: 'north', text: 'Север: без осадков.', notes: [], fetchedAt: '2026-10-29T05:40:00Z', kind: 'day1' },
    ],
  };
  it('текст дословно с датой и районом, пометка об обоих районах, источник и время чтения', () => {
    const { container } = render(<UgmsForecast read={items} today="2026-10-29" />);
    const t = container.textContent ?? '';
    expect(t).toContain('Прогноз Камчатского УГМС');
    expect(t).toContain('Завтра, 30.10 · южные районы края');
    expect(t).toContain('Юг: снег.');
    expect(t).toContain('На дорогах гололедица');
    expect(t).toContain('Завтра, 30.10 · северные районы края');
    expect(t).toContain('Граница южных и северных районов в прогнозе не названа');
    expect(t).toContain('ФГБУ «Камчатское УГМС»');
    expect(t).toMatch(/прочитан 29 октября.{0,4}17:40 по Камчатке/);
    expect(container.querySelector('a[href="https://kammeteo.ru"]')).toBeTruthy();
  });
  it('пусто — «у нас нет», не «погода спокойная»; отказ — «сбой»', () => {
    const empty = render(<UgmsForecast read={{ ...items, items: [], ambiguous: false }} today="2026-10-29" />);
    expect(empty.container.textContent).toContain('не прочитан с сайта');
    expect(empty.container.textContent).toContain('не значит, что погода спокойная');
    cleanup();
    const failed = render(<UgmsForecast read={{ kind: 'failed', reason: 'прогноз УГМС не прочитан из базы' }} today="2026-10-29" />);
    expect(failed.container.textContent).toContain('Это сбой у нас');
    expect(failed.container.textContent).not.toContain('погода спокойная');
  });
});
