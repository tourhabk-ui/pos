// @vitest-environment jsdom
/**
 * Путь страницы партнёра не приносит нам чужие ПД (аудит 15.10, находка
 * R-path, ревью PR #2518). Судится поведением: вызовом правила на граничных
 * путях и исполнением скриптов партнёра в DOM — не текстом исходника.
 *
 * Что было: чистка пути ловила только 7 и больше цифр ПОДРЯД, и номер в
 * записи человека — `/spasibo/8-914-123-45-67`, `/zakaz/%2B7%20914%20123%2045%2067`
 * — ложился в chat_sessions.widget_origin.path и leads.source_data, а оттуда
 * GET /api/leads отдавал его оператору. Скрипты на сайте партнёра (embed.js,
 * выдача lead.js) клали путь в адрес окна сырым, так что даже заменённое
 * сервером уже лежало в access-логах и в Referer запросов окна.
 *
 * Правило живёт в трёх местах — scrubWidgetPath (через normalizeWidgetPath),
 * копия в public/widget/embed.js (статический файл без сборки) и копия в
 * выдаче /api/widget/lead.js. Чтобы они не разошлись, ОДИН набор путей ниже
 * идёт через все три, и ответ у всех трёх обязан совпасть.
 *
 * Ревью R-path (15.10): первая редакция правила разбирала путь из одних `+`
 * КВАДРАТИЧНО (`[+(]*` перед цифрой) — 100 тысяч `+` в теле POST /api/leads
 * держали событийный цикл Node 13 с, а ссылка на страницу партнёра с таким
 * путём вешала вкладку посетителя. Здесь же держится и это: регэксп, которым
 * каждое из трёх мест режет сегмент, ловится при настоящем вызове и гоняется
 * на враждебном входе по времени; путь длиннее предела не разбирается ни в
 * одном из трёх мест.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { normalizeWidgetPath, widgetOrigin, readWidgetOriginParams } from '@/lib/embed/widget-origin';
import { WIDGET_PATH_SCRUB_MAX } from '@/lib/embed/widget-path-scrub';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

/**
 * [что за путь, location.pathname как его показывает браузер, путь в адресе
 * окна и в записи, цифры номера, которых не должно быть нигде].
 */
const CASES: ReadonlyArray<readonly [string, string, string, string | null]> = [
  ['телефон через дефисы', '/spasibo/8-914-123-45-67', '/spasibo/{digits}', '89141234567'],
  ['то же, другой сегмент', '/a/8-914-123-45-67', '/a/{digits}', '89141234567'],
  ['плюс и пробелы под %-кодированием', '/a/%2B7%20914%20123%2045%2067', '/a/{digits}', '79141234567'],
  ['плюс как есть, пробелы кодом', '/zakaz/+7%20914%20123%2045%2067', '/zakaz/{digits}', '79141234567'],
  ['скобки и дефисы', '/a/+7(914)123-45-67', '/a/{digits}', '79141234567'],
  ['скобки и точки', '/a/8(914)123.45.67', '/a/{digits}', '89141234567'],
  ['цифры подряд (прежнее правило)', '/zakaz/79001234567/', '/zakaz/{digits}/', '79001234567'],
  ['номер внутри слова', '/zakaz-8-914-123-45-67/', '/zakaz-{digits}/', '89141234567'],
  ['номер внутри кириллицы', '/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7-8-914-123-45-67', '/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7-{digits}', '89141234567'],
  ['двойное кодирование', '/a/%252B7%2520914%2520123%252045%252067', '/a/{digits}', '79141234567'],
  ['цифры кодом', '/a/%38%39%31%34%31%32%33%34%35%36%37', '/a/{digits}', '89141234567'],
  ['подчёркивания', '/a/8_914_123_45_67', '/a/{digits}', '89141234567'],
  ['тире кодом', '/a/8%E2%80%93914%E2%80%93123%E2%80%9345%E2%80%9367', '/a/{digits}', '89141234567'],
  ['паспорт через пробел', '/doc/4510%20123456', '/doc/{digits}', '4510123456'],
  ['ровно семь цифр — номер', '/a/123-45-67', '/a/{digits}', '1234567'],
  ['почта сегментом', '/user@mail.ru/x', '/{email}/x', null],
  ['почта кодом', '/u/ivan%40mail.ru/', '/u/{email}/', null],
  ['сегмент не раскрывается — меткой целиком', '/skidka-50%/tury', '/{undecodable}/tury', null],
  ['обычный путь с годом', '/tours/2026', '/tours/2026', null],
  ['обычный путь', '/tury/vertolet', '/tury/vertolet', null],
  ['обычный путь со слэшем', '/tury/vertolet/', '/tury/vertolet/', null],
  ['корень', '/', '/', null],
  ['карточка тура', '/catalog/tours/51', '/catalog/tours/51', null],
  ['шесть цифр — не номер', '/a/123-456', '/a/123-456', null],
  ['кириллица без номера — байт в байт', '/%D1%82%D1%83%D1%80%D1%8B/2026/', '/%D1%82%D1%83%D1%80%D1%8B/2026/', null],
  ['буквальный процент после раскрытия', '/skidka-50%25/', '/skidka-50%25/', null],
];

/** Все раскрытия строки (до трёх) — номер не должен найтись ни в одном. */
function decodings(s: string): string[] {
  const out = [s];
  let cur = s;
  for (let i = 0; i < 3; i++) {
    try { cur = decodeURIComponent(cur); } catch { break; }
    out.push(cur);
  }
  return out;
}

function expectNoNumber(s: string, digits: string | null) {
  for (const d of decodings(s)) {
    if (digits) expect(d.replace(/\D/g, '')).not.toContain(digits.slice(1));
    expect(d).not.toMatch(/mail\.ru/);
  }
}

/** Путь, сегмент которого правило обязано разобрать регэкспом. */
const PROBE_PATH = '/a/8-914-123-45-67';
const PROBE_SEG = '8-914-123-45-67';

/**
 * Регэкспы, которыми `run` режет сегмент PROBE_SEG, — пойманные при настоящем
 * вызове, а не найденные в тексте: так судится и embed.js, чья копия правила
 * заперта в замыкании скрипта и снаружи не вызывается.
 */
function segmentSplitters(run: () => unknown): RegExp[] {
  const seen: RegExp[] = [];
  const split = String.prototype.split;
  String.prototype.split = function (this: string, sep: unknown, limit?: number) {
    if (sep instanceof RegExp && String(this) === PROBE_SEG) seen.push(sep);
    return split.call(this, sep as string, limit);
  } as typeof split;
  try {
    run();
  } finally {
    String.prototype.split = split;
  }
  return seen;
}

/**
 * Враждебный сегмент: одни `+`, одни `(`, вперемешку — без единой цифры.
 * Квадратичный разбор на 50 тысячах знаков — около 3 с, линейный — меньше
 * миллисекунды; порог в 250 мс не путает одно с другим и на медленной машине.
 */
const HOSTILE = ['+', '(', '(+'].map((c) => c.repeat(50_000 / c.length));

function expectLinear(splitters: RegExp[]) {
  expect(splitters.length).toBeGreaterThan(0);
  for (const re of splitters) {
    for (const s of HOSTILE) {
      const t0 = performance.now();
      s.split(re);
      expect(performance.now() - t0).toBeLessThan(250);
    }
  }
}

/** Портянка из одних `+` — то, что прислал бы атакующий. */
const FLOOD = '/' + '+'.repeat(100_000);
/** Длина ровно на пределе — ещё путь; на знак длиннее — уже нет. */
const AT_LIMIT = '/' + 'a'.repeat(WIDGET_PATH_SCRUB_MAX - 1);
const OVER_LIMIT = '/' + 'a'.repeat(WIDGET_PATH_SCRUB_MAX);

/** Время вызова в мс. */
function timed<T>(run: () => T): [T, number] {
  const t0 = performance.now();
  const out = run();
  return [out, performance.now() - t0];
}

describe('правило на сервере — normalizeWidgetPath и запись', () => {
  it.each(CASES)('%s', (_name, pathname, expected, digits) => {
    expect(normalizeWidgetPath(pathname)).toBe(expected);
    expectNoNumber(normalizeWidgetPath(pathname)!, digits);
  });

  it.each(CASES)('идемпотентно — чистый путь проходит без изменений: %s', (_name, pathname) => {
    const once = normalizeWidgetPath(pathname)!;
    expect(normalizeWidgetPath(once)).toBe(once);
  });

  it.each(CASES)('старый скрипт из кэша прислал сырой путь — в запись идёт чистый: %s', (_name, pathname, expected) => {
    const fromFrame = readWidgetOriginParams(`?host=mestechkokam.ru&path=${encodeURIComponent(pathname)}`);
    expect(fromFrame.path).toBe(expected);
    expect(widgetOrigin('mestechkokam.ru', pathname, ['mestechkokam.ru'])).toEqual({
      host: 'mestechkokam.ru', path: expected, host_check: 'listed',
    });
  });

  it('длина режется после чистки: номер на краю не рассекается на куски', () => {
    const pathname = '/' + 'a'.repeat(190) + '/8-914-123-45-67';
    const p = normalizeWidgetPath(pathname)!;
    expect(p.length).toBeLessThanOrEqual(200);
    expect(p.replace(/\D/g, '')).not.toContain('8914');
  });

  it('разбор линейный: регэксп, которым правило режет сегмент, не квадратичен на враждебном входе', () => {
    expectLinear(segmentSplitters(() => normalizeWidgetPath(PROBE_PATH)));
  });

  it('путь длиннее предела не разбирается — null, и быстро; хост при этом записывается', () => {
    const [p, ms] = timed(() => normalizeWidgetPath(FLOOD));
    expect(p).toBeNull();
    expect(ms).toBeLessThan(250);
    expect(widgetOrigin('mestechkokam.ru', FLOOD, ['mestechkokam.ru'])).toEqual({
      host: 'mestechkokam.ru', path: null, host_check: 'listed',
    });
    expect(normalizeWidgetPath(AT_LIMIT)).toBe(AT_LIMIT.slice(0, 200));
    expect(normalizeWidgetPath(OVER_LIMIT)).toBeNull();
  });

  it('пустой путь от скрипта (портянка не отправлена) — в записи «пути нет»', () => {
    expect(readWidgetOriginParams('?host=mestechkokam.ru&path=')).toEqual({ host: 'mestechkokam.ru', path: null });
  });
});

let beforeHref = '';
beforeEach(() => {
  beforeHref = location.href;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: vi.fn(() => true) });
});
afterEach(() => {
  window.history.replaceState({}, '', beforeHref);
});

/** Страница партнёра с этим путём; браузер показывает его как есть. */
function onPartnerPage(pathname: string) {
  window.history.replaceState({}, '', pathname);
  expect(location.pathname).toBe(pathname);
}

describe('embed.js (чат): путь в адресе окна уже чистый', () => {
  const SRC = readFileSync(join(process.cwd(), 'public/widget/embed.js'), 'utf-8');

  function frameSrc(pathname: string): URL {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    onPartnerPage(pathname);
    const s = document.createElement('script');
    s.src = 'https://vedarai.ru/widget/embed.js';
    s.setAttribute('data-partner-id', 'mestechko');
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true });
    new Function(SRC)();
    (document.getElementById('tourhub-widget-btn') as HTMLButtonElement).click();
    return new URL((document.getElementById('tourhub-widget-frame') as HTMLIFrameElement).getAttribute('src')!);
  }

  it.each(CASES)('%s', (_name, pathname, expected, digits) => {
    const src = frameSrc(pathname);
    expect(src.searchParams.get('path')).toBe(expected);
    expectNoNumber(src.href, digits);
  });

  it('длинный путь режется после чистки — номер на краю не уходит кусками', () => {
    const src = frameSrc('/' + 'a'.repeat(190) + '/8-914-123-45-67');
    expect(src.searchParams.get('path')!.length).toBeLessThanOrEqual(200);
    expect(src.searchParams.get('path')!.replace(/\D/g, '')).not.toContain('8914');
  });

  it('разбор линейный: регэксп копии правила не квадратичен на враждебном входе', () => {
    expectLinear(segmentSplitters(() => frameSrc(PROBE_PATH)));
  });

  it('путь длиннее предела не разбирается и в адрес окна не идёт — вкладка не виснет', () => {
    const [src, ms] = timed(() => frameSrc(FLOOD));
    expect(src.searchParams.get('path')).toBe('');
    expect(ms).toBeLessThan(2000);
    expect(frameSrc(AT_LIMIT).searchParams.get('path')).toBe(AT_LIMIT.slice(0, 200));
    expect(frameSrc(OVER_LIMIT).searchParams.get('path')).toBe('');
  });
});

describe('выдача lead.js (форма): путь в адресе окна уже чистый', () => {
  const PARTNER = {
    id: '11111111-1111-1111-1111-111111111111', name: 'Местечко Камчатка', slug: 'mestechko',
    widget_config: {}, widget_domains: ['mestechkokam.ru'],
  };
  let script = '';

  beforeEach(async () => {
    poolQuery.mockReset();
    poolQuery.mockImplementation(async (sql: string) =>
      /FROM partners/.test(sql) ? { rows: [PARTNER] } : { rows: [], rowCount: 1 });
    if (!script) {
      const { GET } = await import('@/app/api/widget/lead.js/route');
      const res = await GET(new NextRequest('https://vedarai.ru/api/widget/lead.js?partner=mestechko'));
      expect(res.status).toBe(200);
      script = await res.text();
    }
  });

  function frameSrc(pathname: string): URL {
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>).__th_widget_mestechko;
    onPartnerPage(pathname);
    new Function(script)();
    return new URL((document.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')!);
  }

  it.each(CASES)('%s', (_name, pathname, expected, digits) => {
    const src = frameSrc(pathname);
    expect(src.searchParams.get('path')).toBe(expected);
    expectNoNumber(src.href, digits);
  });

  it('длинный путь режется после чистки — номер на краю не уходит кусками', () => {
    const src = frameSrc('/' + 'a'.repeat(190) + '/8-914-123-45-67');
    expect(src.searchParams.get('path')!.length).toBeLessThanOrEqual(200);
    expect(src.searchParams.get('path')!.replace(/\D/g, '')).not.toContain('8914');
  });

  it('разбор линейный: регэксп копии правила не квадратичен на враждебном входе', () => {
    expectLinear(segmentSplitters(() => frameSrc(PROBE_PATH)));
  });

  it('путь длиннее предела не разбирается и в адрес окна не идёт — вкладка не виснет', () => {
    const [src, ms] = timed(() => frameSrc(FLOOD));
    expect(src.searchParams.get('path')).toBe('');
    expect(ms).toBeLessThan(2000);
    expect(frameSrc(AT_LIMIT).searchParams.get('path')).toBe(AT_LIMIT.slice(0, 200));
    expect(frameSrc(OVER_LIMIT).searchParams.get('path')).toBe('');
  });
});
