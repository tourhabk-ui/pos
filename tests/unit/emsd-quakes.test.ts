// @vitest-environment node
/**
 * Сейсмика с emsd.ru: разбор таблицы, запись в ленту, один толчок — одно
 * предупреждение.
 *
 * ── Повод (24.09, решение владельца) ──────────────────────────────────────
 *
 * «нам нужно переключиться на этот ресурс, tg не активен у них». Диапазон
 * M4.0–4.9 шёл ТОЛЬКО из телеграм-канала EQKam: USGS спрашивается с M5.0.
 * Канал замолчал, и всё слабее пятёрки перестало существовать для ленты.
 *
 * ── Про фикстуру ──────────────────────────────────────────────────────────
 *
 * Она СИНТЕТИЧЕСКАЯ, и это сказано и в ней самой: разметки живой главной у
 * меня нет (сайт закрыт из контейнера разработки), есть только текст,
 * вставленный владельцем. Числа — дословно оттуда, теги — мои. Поэтому
 * парсер читает текст, а не теги, и здесь отдельно проверяется, что другая
 * обёртка тех же строк разбирается так же.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/safety/ledger', () => ({
  appendSafetyEvent: vi.fn().mockResolvedValue({ id: 'ledger-1' }),
  hashPayload: vi.fn().mockReturnValue('hash'),
}));

import { parseEmsdQuakes, EMSD_HOME_URL } from '@/lib/services/safety/emsd-quakes';
import {
  ingestEmsdQuakes,
  emsdQuakeId,
  findSameQuake,
  saveQuakeOnce,
  severityForMagnitude,
  SAME_QUAKE_KM,
  type SeismicEvent,
} from '@/lib/services/safety/seismic-parser';
import { alertOrigin } from '@/lib/safety/alert-origin';

const HTML = readFileSync(
  join(process.cwd(), 'tests/fixtures/safety/emsd-home-quakes-2026-09-21.html'),
  'utf-8',
);

describe('таблица разбирается', () => {
  const t = parseEmsdQuakes(HTML);

  it('без жалоб и все десять строк', () => {
    expect(t.problems).toEqual([]);
    expect(t.rows.length).toBe(10);
    expect(t.rejected).toEqual([]);
  });

  it('порог взят из заголовка, запятая — десятичный знак', () => {
    // «Ml &gt; 4,0» — ещё и сущность в заголовке: без раскодирования
    // заголовок не нашёлся бы вовсе.
    expect(t.threshold).toBe(4);
  });

  it('первая строка — дословно', () => {
    expect(t.rows[0]).toMatchObject({
      timeUtc: '2026-09-21T03:09:35.000Z', lat: 52.08, lng: 159.24, depthKm: 50, ml: 4.2,
    });
  });

  it('дробные секунды разной длины не ломают разбор', () => {
    // .9219, .735, .0004 — у источника нет фиксированной ширины.
    expect(t.rows.map((r) => r.timeUtc)).toContain('2026-09-17T19:05:55.000Z');
    expect(t.rows.map((r) => r.timeUtc)).toContain('2026-09-19T14:42:04.000Z');
  });

  it('оперативный блок над таблицей в события не попадает', () => {
    // «Время UTC: 21 SEP 2026 03:09:36 … Магнитуда (Ml): 4.1» — то же
    // событие в оперативном решении. Он стоит ДО заголовка и в другом
    // формате; прими его парсер — один толчок дал бы две строки.
    expect(t.rows.filter((r) => r.timeUtc.startsWith('2026-09-21')).length).toBe(1);
  });

  it('другая обёртка тех же строк разбирается так же', () => {
    // Живая разметка мне неизвестна — поэтому разбор обязан не зависеть от неё.
    const plain = `<div>Последние 10 землетрясений Камчатки с Ml > 4,0</div>
      <pre>2026-09-21 03:09:35.9219\t52.08\t159.24\t50\t4.2
      2026-09-20 20:41:11.0059\t49.01\t156.67\t30\t4.2</pre>`;
    const p = parseEmsdQuakes(plain);
    expect(p.rows.length).toBe(2);
    expect(p.rows[0].ml).toBe(4.2);
  });
});

describe('отказ не выдаётся за «землетрясений не было»', () => {
  it('нет заголовка — ноль строк и жалоба, а не поиск по всей странице', () => {
    const p = parseEmsdQuakes(HTML.replace(/Последние 10 землетрясений/, 'Архив событий'));
    expect(p.rows).toEqual([]);
    expect(p.problems.join(' ')).toMatch(/заголовок таблицы/);
  });

  it('заголовок есть, строк нет — жалоба', () => {
    const p = parseEmsdQuakes('<h3>Последние 10 землетрясений Камчатки с Ml &gt; 4,0</h3><p>нет данных</p>');
    expect(p.rows).toEqual([]);
    expect(p.problems.length).toBeGreaterThan(0);
  });

  it('перепутанные колонки отвергаются С ПРИЧИНОЙ, а не молча', () => {
    // Долгота на месте широты — в регион не влезает.
    const p = parseEmsdQuakes(
      '<h3>Последние 10 землетрясений Камчатки с Ml &gt; 4,0</h3>2026-09-21 03:09:35 159.24 52.08 50 4.2',
    );
    expect(p.rows).toEqual([]);
    expect(p.rejected.length).toBe(1);
    expect(p.rejected[0].why).toMatch(/широта/);
    expect(p.problems.join(' ')).toMatch(/отвергнуты/);
  });

  it('несуществующая дата не превращается в соседнюю', () => {
    // Date.UTC(2026, 1, 30) молча дал бы 2 марта.
    const p = parseEmsdQuakes(
      '<h3>Последние 10 землетрясений Камчатки с Ml &gt; 4,0</h3>2026-02-30 03:09:35 52.08 159.24 50 4.2',
    );
    expect(p.rows).toEqual([]);
    expect(p.rejected[0].why).toMatch(/дата/);
  });
});

describe('правила — общие с остальными источниками', () => {
  it('важность по магнитуде — одна функция, пороги прежние', () => {
    expect(severityForMagnitude(4.9)).toBe(0);
    expect(severityForMagnitude(5)).toBe(1);
    expect(severityForMagnitude(6)).toBe(2);
    expect(severityForMagnitude(7)).toBe(3);
  });

  it('копий правила важности в seismic-parser не осталось', () => {
    const src = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');
    const copies = src.match(/mag\s*>=\s*7\s*\?\s*3/g) ?? [];
    expect(copies.length, 'правило важности снова записано в нескольких местах').toBe(1);
  });

  it('id — время очага до секунды: уточнение решения гасится, а не множится', () => {
    expect(emsdQuakeId('2026-09-21T03:09:35.000Z')).toBe('www.emsd.ru/eq/2026-09-21T03:09:35Z');
  });

  it('у предупреждения назван источник — турист не видит «не записан»', () => {
    expect(alertOrigin('www.emsd.ru/eq/2026-09-21T03:09:35Z', EMSD_HOME_URL)?.key).toBe('emsd_quakes');
  });
});

describe('запись в ленту', () => {
  const NOW = Date.parse('2026-09-21T06:00:00Z');
  let sameQuakeRows: Array<Record<string, unknown>>;
  let inserts: unknown[][];

  beforeEach(() => {
    sameQuakeRows = [];
    inserts = [];
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (/lat::float8 AS lat/.test(sql)) return { rows: sameQuakeRows, rowCount: sameQuakeRows.length };
      if (/INSERT INTO external_alerts/.test(sql)) {
        inserts.push(params);
        return { rows: [{ id: inserts.length }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it('пишется только то, что ещё не истекло', async () => {
    // На 21.09 06:00 в пределах суток (срок предупреждения при Ml < 5) три
    // строки: 21.09 03:09, 20.09 20:41 и 20.09 11:30 — последняя 18,5 ч назад.
    // Остальные семь — история, и в ленту как свежие уйти не должны.
    const r = await ingestEmsdQuakes(HTML, NOW);
    expect(r.inserted).toBe(3);
    expect(r.skippedExpired).toBe(7);
    const titles = inserts.map((p) => String(p[2]));
    expect(titles[0]).toMatch(/^Землетрясение ML 4\.2 — \d+ км от Петропавловска-Камчатского$/);
  });

  it('в запись уходят координаты и магнитуда — по ним сверяются другие источники', async () => {
    await ingestEmsdQuakes(HTML, NOW);
    const first = inserts[0];
    // $10 magnitude, $11 lat, $12 lng — порядок колонок INSERT saveEvent.
    expect(first[9]).toBe(4.2);
    expect(first[10]).toBe(52.08);
    expect(first[11]).toBe(159.24);
    expect(first[8]).toBe('www.emsd.ru/eq/2026-09-21T03:09:35Z');
  });

  it('тот же толчок уже пришёл от USGS — не пишется второй раз', async () => {
    sameQuakeRows = [{ external_id: 'usgs/us7000abcd', lat: 52.1, lng: 159.2, magnitude: 4.4 }];
    const r = await ingestEmsdQuakes(HTML, NOW);
    expect(r.skippedSameQuake).toBeGreaterThan(0);
    expect(inserts.map((p) => p[8])).not.toContain('www.emsd.ru/eq/2026-09-21T03:09:35Z');
  });

  it('жалобы разбора делают прогон частичным, а не растворяются в нуле', async () => {
    const r = await ingestEmsdQuakes('<p>Сервис временно недоступен</p>', NOW);
    expect(r.inserted).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('«тот же толчок» — по физике, и афтершок не съедается', () => {
  const base: SeismicEvent = {
    source_id: 'www.emsd.ru/eq/2026-09-21T03:09:35Z',
    source_url: EMSD_HOME_URL,
    published_at: new Date('2026-09-21T03:09:35Z'),
    alert_type: 'earthquake',
    severity: 0,
    title: 'x',
    description: 'x',
    affected_zones: [],
    magnitude: 4.2,
    lat: 52.08,
    lng: 159.24,
    expires_hours: 24,
  };

  // Фигурные скобки обязательны. `() => queryMock.mockReset()` ВОЗВРАЩАЕТ сам
  // мок, а функцию, возвращённую из beforeEach, vitest считает завершающим
  // обработчиком и зовёт после теста. В тесте с отказом БД это был вызов
  // бросающего мока уже после проверки — и падение, которое выглядело как
  // «findSameQuake не ловит исключение», хотя она его ловила.
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('рядом и похожая магнитуда — тот же', async () => {
    queryMock.mockResolvedValue({ rows: [{ external_id: 'usgs/a', lat: 52.12, lng: 159.10, magnitude: 4.5 }] });
    expect(await findSameQuake(base)).toBe('usgs/a');
  });

  it(`дальше ${SAME_QUAKE_KM} км — другой`, async () => {
    queryMock.mockResolvedValue({ rows: [{ external_id: 'usgs/b', lat: 53.5, lng: 160.5, magnitude: 4.2 }] });
    expect(await findSameQuake(base)).toBeNull();
  });

  it('афтершок рядом с главным толчком — другой событие, не сливается', async () => {
    // Главный M6.3 и афтершок Ml 4.2 в 40 км через 20 с: без условия на
    // магнитуду афтершок пропал бы из ленты.
    queryMock.mockResolvedValue({ rows: [{ external_id: 'usgs/main', lat: 52.3, lng: 159.5, magnitude: 6.3 }] });
    expect(await findSameQuake(base)).toBeNull();
  });

  it('БД отказала — «не смог», и запись всё равно идёт', async () => {
    queryMock.mockRejectedValue(new Error('connection terminated'));
    expect(await findSameQuake(base)).toBe('unknown');
  });

  it('нет координат — «не смог», а не «точно другой»', async () => {
    expect(await findSameQuake({ ...base, lat: undefined })).toBe('unknown');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('интервал в SQL не склеен строкой', () => {
    const src = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');
    const at = src.indexOf('export async function findSameQuake');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toMatch(/\$3::int \* INTERVAL '1 second'/);
    expect(body).not.toMatch(/\|\|\s*' second/);
  });
});

describe('сверка — во ВСЕХ путях записи землетрясений', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');
  const bodyOf = (sig: string) => {
    const at = SRC.indexOf(sig);
    expect(at, `${sig} не найден`).toBeGreaterThan(0);
    return SRC.slice(at, SRC.indexOf('\n}\n', at));
  };

  // Четыре пути, и сверка обязана стоять в каждом. Первая редакция 24.09
  // поставила её в два: EQKam сверки не имел, и толчок, уже записанный от
  // emsd.ru, он повторил бы под своим заголовком. Коммит при этом утверждал,
  // что дубли с телеграм-резервом гасятся, — утверждение было ложным, пока
  // этой проверки не было.
  for (const sig of [
    'export async function ingestUsgs',
    'export async function ingestEqkam',
    'export async function ingestFromHtml',
    'export async function ingestEmsdQuakes',
  ]) {
    it(`${sig.replace('export async function ', '')}: пишет через saveQuakeOnce, а не мимо`, () => {
      const body = bodyOf(sig);
      expect(body).toContain('saveQuakeOnce(event)');
      expect(body, 'прямой saveEvent в обход сверки').not.toMatch(/await saveEvent\(/);
    });
  }

  it('emsd пишется ПОСЛЕ USGS, а не одновременно', () => {
    // Одновременная запись: оба сверились, оба не нашли, оба записали.
    const route = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8');
    const fetchAt = route.indexOf('fetchEmsdPage(EMSD_HOME_URL)');
    const ingestAt = route.indexOf('ingestEmsdQuakes(');
    const allAt = route.indexOf('ingestAll(),');
    expect(fetchAt).toBeGreaterThan(0);
    expect(allAt).toBeGreaterThan(0);
    expect(ingestAt, 'запись emsd стоит внутри того же Promise.all, что и USGS').toBeGreaterThan(fetchAt);
    const promiseAllEnd = route.indexOf(']);', allAt);
    expect(ingestAt).toBeGreaterThan(promiseAllEnd);
  });
});

describe('saveQuakeOnce', () => {
  const quake: SeismicEvent = {
    source_id: 't.me/eqkam/5514',
    source_url: 'https://t.me/eqkam/5514',
    published_at: new Date('2026-09-21T03:09:36Z'),
    alert_type: 'earthquake',
    severity: 0,
    title: 'Землетрясение ML 4.1 — 110 км от Петропавловска-Камчатского',
    description: 'x',
    affected_zones: ['avachinsky'],
    magnitude: 4.1,
    lat: 52.1218,
    lng: 159.1017,
    expires_hours: 24,
  };
  let inserts: number;

  beforeEach(() => {
    inserts = 0;
    queryMock.mockReset();
  });

  it('EQKam после emsd.ru — тот же толчок, второй записи нет', async () => {
    // Оперативное решение EQKam (52.1218, 159.1017, Ml 4.1) и табличное
    // emsd.ru (52.08, 159.24, Ml 4.2) — одно событие в ~10 км.
    queryMock.mockImplementation(async (sql: string) => {
      if (/lat::float8 AS lat/.test(sql)) {
        return { rows: [{ external_id: 'www.emsd.ru/eq/2026-09-21T03:09:35Z', lat: 52.08, lng: 159.24, magnitude: 4.2 }], rowCount: 1 };
      }
      if (/INSERT INTO external_alerts/.test(sql)) inserts++;
      return { rows: [], rowCount: 0 };
    });
    expect(await saveQuakeOnce(quake)).toBe('same_quake');
    expect(inserts).toBe(0);
  });

  it('не землетрясение — физическая сверка не спрашивается', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await saveQuakeOnce({ ...quake, alert_type: 'flood', source_id: 'mchs/1' });
    const asked = queryMock.mock.calls.some((c) => /lat::float8 AS lat/.test(String(c[0])));
    expect(asked, 'сводку МЧС сверили как землетрясение').toBe(false);
  });
});
