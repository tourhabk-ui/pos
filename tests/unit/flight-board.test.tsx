// @vitest-environment jsdom
/**
 * Табло аэропорта Елизово (карт-бланш владельца 29.10, #2788).
 *
 * Источник — официальное табло pkc.aero (пробы 1001–1006: рейсы и статусы
 * в разметке, robots.txt их не закрывает). Разметка строки ниже повторяет
 * живую: ссылка на карточку рейса и семь ячеек table-flex__td--type1…7.
 *
 *  - разбор — вызовом: время по Камчатке в UTC, задержка из расписания и
 *    ожидаемого времени (а не из слова статуса), год у «01.01» в конце
 *    декабря, код аэропорта без самого Елизово;
 *  - пустая страница без шапки таблицы — отказ, а не «рейсов нет»;
 *  - загрузка — три исхода и память на три минуты;
 *  - страница — рендером: задержки наверху, «не загрузилось» без «задержек
 *    нет», источник и справочная;
 *  - Кузьмич — по номеру рейса в любом написании, только в чате (не в MCP).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import {
  parsePkcBoard, boardTime, loadPkcBoard, resetPkcBoardCache, lateWords,
  PKC_BOARD_URL, type PkcBoard,
} from '@/lib/flights/pkc-board';
import { FlightBoardView } from '@/components/flights/FlightBoardView';
import { flightBoardText, flightKeys } from '@/lib/kuzmich/flight-tool';
import { TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOL_NAMES } from '@/lib/mcp/public-tools';

afterEach(() => { cleanup(); resetPkcBoardCache(); vi.restoreAllMocks(); });

/** 29.10 11:20 по Камчатке. */
const NOW = new Date('2026-10-28T23:20:00Z');

function row(o: { id: string; time: string; date: string; flight: string; airline: string; city: string; code?: string; status?: string; color?: string; expTime?: string; expDate?: string; note?: string }): string {
  return `
<a href="/board/${o.id}/" class="table-flex__row table-flex__row--link align-center">
	<div class="table-flex__td table-flex__td--type1">
		<span class="board__text">
${o.time}</span>
		<span class="board__text-extra">
${o.date} </span>
	</div>
	<div class="table-flex__td table-flex__td--type2">
		<span>
${o.flight}</span>
	</div>
	<div class="table-flex__td table-flex__td--type3">
		<div class="table-aircompany-logo" style="background-image:url(/upload/airregions.flights/e96/KAP.png);" data-placement="bottom" title="${o.airline}">
</div>
		<div class="table-aircompany-logo-alt">
${o.airline}</div>
	</div>
	<div class="table-flex__td table-flex__td--type4">
		<span class="table-flex__no-wrap">
			<span class="board__text">
${o.city}</span>
		</span>
		${o.code ? `<span class="board__text-extra">${o.code}</span>` : ''}
	</div>
	<div class="table-flex__td table-flex__td--type5">
		${o.status ? `<span class="${o.color ?? ''}">
${o.status}</span>` : ''}
	</div>
	<div class="table-flex__td table-flex__td--type6">
		${o.expTime ? `<span class="board__text">
${o.expTime}</span>
		<span class="board__text-extra">
${o.expDate} </span>` : ''}
	</div>
			<div class="table-flex__td table-flex__td--type7">
	${o.note ?? ''}
	</div>
	</a>`;
}

const HEAD = `<div class="table-flex__row"><div class="table-flex__th table-flex__th--type1"><span>Время по расписанию</span></div></div>
<a href="/board/?ready=yes" class="table-flex__link-btn"><span>Показать вылетевшие рейсы</span></a>`;

const DEP_HTML = `<html><body>${HEAD}
${row({ id: 'dep-ptk-1', time: '10:00', date: '29.10', flight: 'PTK-173', airline: 'Камчатское авиационное предприятие', city: 'Соболево', code: 'PKC', status: 'Отменен', color: 'color-red', expTime: '10:00', expDate: '29.10' })}
${row({ id: 'dep-ptk-2', time: '11:30', date: '28.10', flight: 'PTK-107', airline: 'Камчатское авиационное предприятие', city: 'Тиличики', code: 'PKC', status: 'Задержан', color: 'color-orange', expTime: '12:55', expDate: '29.10' })}
${row({ id: 'dep-ptk-2710600', time: '10:30', date: '29.10', flight: 'PTK-123', airline: 'Камчатское авиационное предприятие', city: 'Оссора', status: 'Посадка закончена', expTime: '11:40', expDate: '29.10' })}
${row({ id: 'dep-tga-1', time: '10:20', date: '29.10', flight: 'TGA-2653', airline: 'Тайга', city: 'Северо-Курильск', code: 'PKC', status: 'Задержан', color: 'color-orange', expTime: '12:00', expDate: '29.10', note: 'Совмещен c HZ-2653' })}
${row({ id: 'dep-su-1', time: '13:25', date: '29.10', flight: 'SU-1731', airline: 'Аэрофлот', city: 'Москва', code: 'SVO', status: 'Регистрация', expTime: '13:25', expDate: '29.10' })}
${row({ id: 'dep-hz-1', time: '16:00', date: '29.10', flight: 'HZ-4027', airline: 'Аврора', city: 'Южно-Сахалинск', code: 'UUS', expTime: '16:00', expDate: '29.10' })}
</body></html>`;

const ARR_HTML = `<html><body>${HEAD}
${row({ id: 'arr-ptk-9', time: '14:00', date: '23.10', flight: 'PTK-186', airline: 'Камчатское авиационное предприятие', city: 'Усть-Хайрюзово', code: 'PKC', status: 'Задержан', color: 'color-orange', expTime: '19:40', expDate: '29.10' })}
${row({ id: 'arr-hz-2', time: '15:15', date: '29.10', flight: 'HZ-5684', airline: 'Аврора', city: 'Хабаровск', code: 'KHV', status: 'Ожидается', expTime: '15:15', expDate: '29.10' })}
</body></html>`;

describe('разбор табло pkc.aero', () => {
  const dep = parsePkcBoard(DEP_HTML, 'dep', NOW);
  if (dep.kind !== 'ok') throw new Error('ожидался разбор');
  const by = (n: string) => dep.flights.find((f) => f.flight === n)!;

  it('все строки рейсов, а не служебные ссылки табло', () => {
    expect(dep.flights.map((f) => f.flight)).toEqual(['PTK-173', 'PTK-107', 'PTK-123', 'TGA-2653', 'SU-1731', 'HZ-4027']);
  });

  it('время табло — камчатское, в UTC на 12 часов раньше', () => {
    expect(by('SU-1731').scheduledAt).toBe('2026-10-29T01:25:00.000Z');
  });

  it('задержка — из расписания и ожидаемого времени, через сутки тоже', () => {
    expect(by('PTK-107')).toMatchObject({ statusKind: 'delayed', status: 'Задержан', lateMinutes: 25 * 60 + 25, city: 'Тиличики', cityCode: null });
    // «Посадка закончена» на 1 ч 10 мин позже — тоже опоздание, хотя слово другое.
    expect(by('PTK-123')).toMatchObject({ statusKind: 'other', lateMinutes: 70 });
    expect(by('PTK-173')).toMatchObject({ statusKind: 'cancelled', lateMinutes: null });
    expect(by('SU-1731')).toMatchObject({ statusKind: 'other', lateMinutes: null, cityCode: 'SVO', airline: 'Аэрофлот' });
  });

  it('примечание и пустой статус — как на табло, без догадок', () => {
    expect(by('TGA-2653').note).toBe('Совмещен c HZ-2653');
    expect(by('HZ-4027')).toMatchObject({ status: null, statusKind: 'other', note: null });
  });

  it('год у даты без года — ближайший к «сейчас»', () => {
    const newYearEve = new Date('2026-12-31T20:00:00Z'); // 1 января 08:00 по Камчатке
    expect(boardTime('09:00', '01.01', newYearEve)).toBe('2026-12-31T21:00:00.000Z');
    expect(boardTime('23:00', '31.12', newYearEve)).toBe('2026-12-31T11:00:00.000Z');
  });

  it('пустое табло с шапкой — «рейсов нет»; без шапки таблицы — отказ, а не пустота', () => {
    expect(parsePkcBoard(`<html>${HEAD}</html>`, 'dep', NOW)).toEqual({ kind: 'ok', flights: [] });
    expect(parsePkcBoard('<html><body>Технические работы</body></html>', 'dep', NOW).kind).toBe('failed');
  });

  it('«1 дн 1 ч», «1 ч 10 мин», «40 мин»', () => {
    expect(lateWords(1525)).toBe('1 дн 1 ч');
    expect(lateWords(70)).toBe('1 ч 10 мин');
    expect(lateWords(40)).toBe('40 мин');
  });
});

describe('загрузка табло', () => {
  const page = (html: string, status = 200) => new Response(html, { status, headers: { 'content-type': 'text/html' } });

  it('вылет и прилёт с официального табло, своим агентом; повтор за три минуты — из памяти', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => page(String(url).includes('type=arr') ? ARR_HTML : DEP_HTML));
    const board = await loadPkcBoard(NOW, fetchImpl as unknown as typeof fetch);
    expect(board.departures.kind).toBe('ok');
    expect(board.arrivals.kind === 'ok' && board.arrivals.flights.map((f) => f.flight)).toEqual(['PTK-186', 'HZ-5684']);
    expect(fetchImpl.mock.calls.map((c) => String(c[0])).sort()).toEqual([PKC_BOARD_URL, `${PKC_BOARD_URL}?type=arr`]);
    const ua = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(ua['user-agent']).toMatch(/VedarBot/);
    await loadPkcBoard(new Date(NOW.getTime() + 2 * 60_000), fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('отказ сайта — «не прочитано» с причиной у своей половины, вторая читается', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('type=arr')) throw new Error('timeout');
      return page('', 503);
    });
    const board = await loadPkcBoard(NOW, fetchImpl as unknown as typeof fetch);
    expect(board.departures).toEqual({ kind: 'failed', reason: 'сайт аэропорта ответил HTTP 503' });
    expect(board.arrivals.kind === 'failed' && board.arrivals.reason).toMatch(/не ответил \(timeout\)/);
    // Отказ помнится минуту, не три.
    await loadPkcBoard(new Date(NOW.getTime() + 90_000), fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

const OK_BOARD = (): PkcBoard => ({
  departures: parsePkcBoard(DEP_HTML, 'dep', NOW),
  arrivals: parsePkcBoard(ARR_HTML, 'arr', NOW),
  fetchedAt: NOW.toISOString(),
});

describe('страница /flights', () => {
  it('задержки и отмены — наверху, с ожидаемым временем и «позже на»', () => {
    render(<FlightBoardView board={OK_BOARD()} />);
    const top = screen.getByRole('region', { name: 'Задержки и отмены' });
    const flights = [...top.querySelectorAll('[data-flight]')].map((li) => li.getAttribute('data-flight'));
    expect(flights).toEqual(['PTK-173', 'PTK-107', 'PTK-123', 'TGA-2653', 'PTK-186']);
    const late = top.querySelector('[data-flight="PTK-107"]')!;
    expect(late.textContent).toContain('Задержан');
    expect(late.textContent).toContain('12:55');
    expect(late.textContent).toContain('позже на 1 дн 1 ч');
    expect(top.querySelector('[data-flight="PTK-173"]')!.textContent).toContain('Отменен');
    expect(screen.getByText(/снято в 11:20 по Камчатке/)).toBeTruthy();
  });

  it('вылет и прилёт — целиком; источник и справочная аэропорта', () => {
    render(<FlightBoardView board={OK_BOARD()} />);
    expect(within(screen.getByRole('region', { name: 'Вылет' })).getAllByRole('listitem')).toHaveLength(6);
    expect(within(screen.getByRole('region', { name: 'Прилёт' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('link', { name: /табло на сайте аэропорта/ }).getAttribute('href')).toBe(PKC_BOARD_URL);
    expect(screen.getByRole('link', { name: '+7 (41531) 99-999' }).getAttribute('href')).toBe('tel:+74153199999');
  });

  it('табло не загрузилось — так и сказано, и ни слова «задержек нет»', () => {
    const failed: PkcBoard = {
      departures: { kind: 'failed', reason: 'сайт аэропорта ответил HTTP 503' },
      arrivals: { kind: 'failed', reason: 'сайт аэропорта не ответил (timeout)' },
      fetchedAt: NOW.toISOString(),
    };
    const { container } = render(<FlightBoardView board={failed} />);
    expect(screen.getByText('Табло аэропорта сейчас не загрузилось')).toBeTruthy();
    expect(container.textContent).not.toMatch(/задержек и отмен нет/);
    expect(container.textContent).toContain('Это не значит, что задержек нет');
    // Ничего не снято — «снято в …» было бы неправдой.
    expect(container.textContent).not.toMatch(/снято в/);
    expect(container.textContent).toContain('спрошено в 11:20 по Камчатке и не прочиталось');
  });

  it('прочитано и спокойно — «задержек нет» говорится только по прочитанному', () => {
    const calm: PkcBoard = { departures: { kind: 'ok', flights: [] }, arrivals: { kind: 'ok', flights: [] }, fetchedAt: NOW.toISOString() };
    render(<FlightBoardView board={calm} />);
    expect(screen.getByText('На прочитанном табло задержек и отмен нет.')).toBeTruthy();
  });
});

describe('Кузьмич: «мой рейс задержан?»', () => {
  it('номер рейса в любом написании', () => {
    expect(flightKeys('su 1731')).toEqual(['SU1731']);
    // Кириллица: «РТК» похожими буквами, «су» по звучанию — оба прочтения.
    expect(flightKeys('РТК-107')).toContain('PTK107');
    expect(flightKeys('су 1731')).toContain('SU1731');
    expect(flightBoardText(OK_BOARD(), { flight: 'су 1731' })).toContain('SU-1731');
    expect(flightBoardText(OK_BOARD(), { flight: 'РТК-107' })).toContain('статус: Задержан');
    const text = flightBoardText(OK_BOARD(), { flight: 'ptk 107' });
    expect(text).toContain('PTK-107');
    expect(text).toContain('статус: Задержан');
    expect(text).toContain('ожидается 12:55 29.10');
    expect(text).toContain('позже расписания на 1 дн 1 ч');
  });

  it('рейса нет на табло — так и сказано, без выдумки статуса', () => {
    const text = flightBoardText(OK_BOARD(), { flight: 'SU 1730' });
    expect(text).toMatch(/Рейса SU 1730 на табло сейчас нет/);
    expect(text).not.toMatch(/статус:/);
  });

  it('без номера — задержки и отмены; причина не придумывается', () => {
    const text = flightBoardText(OK_BOARD(), {});
    expect(text).toContain('Задержки и отмены:');
    expect(text).toContain('PTK-186');
    expect(text).not.toContain('SU-1731');
    expect(text).toContain('Причину задержки табло не называет.');
  });

  it('табло не прочиталось — не «задержек нет», а справочная', () => {
    const text = flightBoardText({
      departures: { kind: 'failed', reason: 'x' }, arrivals: { kind: 'failed', reason: 'y' }, fetchedAt: NOW.toISOString(),
    }, {});
    expect(text).toContain('Это не значит, что задержек нет');
    expect(text).toContain('+7 (41531) 99-999');
  });

  it('инструмент — в чате Кузьмича, во внешний MCP не выдаётся', () => {
    expect(TOOL_REGISTRY.get_flight_board?.definition.function.name).toBe('get_flight_board');
    expect(PUBLIC_MCP_TOOL_NAMES.has('get_flight_board')).toBe(false);
  });
});
