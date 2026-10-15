/**
 * #2495 (дайджест 14.10) — лента `safety_status` честно называет, что в ней.
 *
 * Что было в ответе MCP: «Активных предупреждений: 7 … меняют решение 5» и
 * пять строк, среди них —
 *   - новость «Сотрудники МЧС России приняли участие в исследовательской
 *     экспедиции на Камчатке»;
 *   - «Вилючинский перевал: проезд по пропускам с 15 июля» в середине октября
 *     без даты записи и срока;
 *   - «Халактырский пляж: дорога … перекрыта» — тоже без даты;
 * а оранжевого по KVERT Шивелуча, красившего место в красный, в ленте не было,
 * и две записи из семи оставались невидимыми.
 *
 * Сторож — вызовом (правило 13.10): классификатор и чистильщик на тексте
 * новости, правило дат, строка остатка, блок вулканов, разбор сверки каналов
 * и связка инструмента — настоящим `executeKuzmichTool`.
 */
import { describe, it, expect, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  status: null as unknown,
  volcanoInput: null as unknown,
  volcanoFails: false,
  query: async (_sql: string): Promise<{ rows: unknown[] }> => ({ rows: [] }),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/database')>()),
  query: vi.fn(async (sql: string) => fx.query(sql)),
}));
vi.mock('@/lib/safety/current-status', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/safety/current-status')>();
  return { ...real, getCurrentSafetyStatus: vi.fn(async () => fx.status) };
});
vi.mock('@/lib/kuzmich/volcano-tool', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/kuzmich/volcano-tool')>();
  return {
    ...real,
    loadVolcanoInput: vi.fn(async () => {
      if (fx.volcanoFails) throw new Error('volcano_status недоступна');
      return fx.volcanoInput;
    }),
  };
});

import { classifyMchsItem, isServiceDuties } from '@/lib/services/safety/seismic-parser';
import { rejectedGenre } from '@/lib/services/safety/alert-prune';
import {
  formatSafetyStatusForAgent, feedWhenLine, outsideFeedLine, type CurrentSafetyStatus,
} from '@/lib/safety/current-status';
import { alertDayLabel } from '@/lib/safety/alert-dates';
import { volcanoLinesForSafetyStatus, SAFETY_STATUS_VOLCANO_LIMIT, type VolcanoInput, type KvertRow } from '@/lib/kuzmich/volcano-tool';
import { parseSafetyText } from '@/lib/quality/channel-parity';
import { executeKuzmichTool } from '@/lib/kuzmich/core';

/** 15.10.2026 13:30 по Камчатке. */
const NOW = Date.parse('2026-10-15T01:30:00Z');
const PUB_S = new Date(NOW - 3600_000).toUTCString();

const EXPEDITION_TITLE = 'Сотрудники МЧС России приняли участие в исследовательской экспедиции на Камчатке';
const EXPEDITION_BODY = `${EXPEDITION_TITLE}. Группа поднялась к кратеру вулкана Горелый, специалисты изучили обстановку на маршрутах и сейсмическую активность.`;

describe('новость об участии службы — не предупреждение', () => {
  it('страж узнаёт «приняли участие», классификатор её не пишет, чистильщик гасит уже лежащую', () => {
    expect(isServiceDuties(EXPEDITION_TITLE)).toBe(true);
    expect(classifyMchsItem('t', EXPEDITION_TITLE, EXPEDITION_BODY, PUB_S, 'https://x')).toBeNull();
    // Тот же страж каждые пять минут чистит хранилище (alert-prune): запись,
    // уже стоящая в ленте, уйдёт сама.
    expect(rejectedGenre(EXPEDITION_TITLE, EXPEDITION_BODY)).toBe('service_duties');
    expect(isServiceDuties('Спасатели принимали участие в учебных сборах на Авачинском перевале')).toBe(true);
  });

  it('вторая копия с прода (prod-check 130): заголовок склеен с телом и начинается с «На Камчатке»', () => {
    // Запись 441994 лежала типом flood: полный текст поста говорил о
    // старом остроге, и слово паводка в нём нашёл классификатор воды.
    const title = 'На Камчатке сотрудники МЧС России приняли участие в исследовательской экспедиции Члены Молодежного совета Главного управления МЧС России по Камчатскому краю совместно с представителями общественной…';
    const body = 'На Камчатке сотрудники МЧС России приняли участие в исследовательской экспедиции \n \nЧлены Молодежного совета Главного управления МЧС России по Камчатскому краю совместно с представителями общественной организации Камчатско-Курильских экспедиций и волонтерами-военнослужащими провели экспедицию на предполагаемом месте нахождения старого Большерецкого острога.';
    expect(rejectedGenre(title, body, new Date(NOW - 5 * 3600_000))).toBe('service_duties');
    expect(classifyMchsItem('t', title, body, PUB_S, 'https://x')).toBeNull();
  });

  it('взгляд вперёд вердикт отменяет: настоящая тревога остаётся тревогой', () => {
    const t = 'Сотрудники МЧС России приняли участие в облёте вулкана Шивелуч';
    const body = `${t}. Ожидается выброс пепла до 10 км, восхождения на вулкан не рекомендуются.`;
    expect(isServiceDuties(body)).toBe(false);
    expect(classifyMchsItem('t', t, body, PUB_S, 'https://x')?.alert_type).toBe('volcanic_eruption');
  });
});

describe('даты записи — словами и без выдуманного «действует до»', () => {
  it('день по Камчатке; год — только если не текущий', () => {
    expect(alertDayLabel('2026-07-03T02:00:00.000Z', NOW)).toBe('3 июля');
    // 20:00 UTC 14.10 — это уже 15.10 на Камчатке.
    expect(alertDayLabel('2026-10-14T20:00:00.000Z', NOW)).toBe('15 октября');
    expect(alertDayLabel('2025-12-30T02:00:00.000Z', NOW)).toBe('30 декабря 2025 г.');
    expect(alertDayLabel(null, NOW)).toBeNull();
  });

  it('пункт ленты: ручная запись названа ручной; срок — окно ленты, а не «действует до»', () => {
    // Миграция 718: «срок окончания НЕ объявлен», expires_at — заглушка 2027.
    // В октябре до неё меньше полугода — правило «дальше полугода не срок» уже
    // выдало бы «до 1 января» за окончание ограничения.
    expect(feedWhenLine({ createdAt: '2026-07-03T02:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', manual: true }, NOW))
      .toBe('внесено вручную 3 июля; в ленте до 1 января 2027 г.');
    expect(feedWhenLine({ createdAt: '2026-10-14T20:00:00.000Z', expiresAt: '2026-10-15T20:00:00.000Z', manual: false }, NOW))
      .toBe('опубликовано 15 октября; в ленте до 16 октября');
    expect(feedWhenLine({ createdAt: null, expiresAt: null, manual: false }, NOW))
      .toBe('опубликовано, дата не записана; срок в ленте не записан');
    expect(feedWhenLine(null, NOW)).toBeNull();
  });

  it('ни в одной строке нет «действует до» и «срок окончания»: этого платформа не знает', () => {
    const text = formatSafetyStatusForAgent(STATUS, undefined, NOW);
    expect(text).not.toMatch(/действует до|срок окончания/);
  });
});

const TITLES = [
  'Штормовое предупреждение: ветер до 25 м/с',
  'Вилючинский перевал: проезд по пропускам с 15 июля',
  'Халактырский пляж: дорога со стороны Дальнего перекрыта',
  'Медведи у посёлка Термальный',
  'Шивелуч: выброс пепла',
];

const STATUS: CurrentSafetyStatus = {
  hasAlert: true,
  maxSeverity: 2,
  activeCount: 7,
  topTitle: TITLES[0],
  topType: 'weather',
  dataUpdatedAt: '2026-10-15T01:20:00.000Z',
  source: 'МЧС России по Камчатскому краю',
  feedCount: 5,
  feedTitles: TITLES,
  feedBasis: [null, null, null, null, null],
  feedWhen: [
    { createdAt: '2026-10-14T20:00:00.000Z', expiresAt: '2026-10-15T20:00:00.000Z', manual: false },
    { createdAt: '2026-07-03T02:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', manual: true },
    { createdAt: '2026-07-09T02:00:00.000Z', expiresAt: '2027-07-01T00:00:00.000Z', manual: true },
    { createdAt: '2026-10-13T22:00:00.000Z', expiresAt: '2026-10-16T22:00:00.000Z', manual: false },
    { createdAt: '2026-10-14T00:00:00.000Z', expiresAt: '2026-10-21T00:00:00.000Z', manual: false },
  ],
  outsideFeed: { byType: [{ type: 'earthquake', count: 1 }, { type: 'info', count: 1 }], repeats: 0 },
};

describe('остаток вне ленты назван', () => {
  it('7 активных, 5 в ленте — остальные 2 по типам', () => {
    expect(outsideFeedLine(STATUS)).toBe('Остальные 2 — вне ленты туриста: землетрясения — 1, сводки и сообщения — 1.');
  });

  it('повторы одной темы — отдельной частью; незнакомый тип — как есть', () => {
    expect(outsideFeedLine({ ...STATUS, outsideFeed: { byType: [{ type: 'mudflow', count: 1 }], repeats: 1 } }))
      .toBe('Остальные 2 — вне ленты туриста: mudflow — 1, повторы уже названной темы — 1.');
  });

  it('не посчитали разбивку — так и сказано; остатка нет — строки нет', () => {
    expect(outsideFeedLine({ ...STATUS, outsideFeed: null }))
      .toBe('Остальные 2 — вне ленты туриста; разбивку по типам посчитать не удалось.');
    expect(outsideFeedLine({ ...STATUS, activeCount: 5 })).toBeNull();
    expect(outsideFeedLine({ ...STATUS, feedCount: null })).toBeNull();
  });
});

const kvert = (name: string, place: string, acc: string, ashM: number | null = null): KvertRow => ({
  ark: place, place_name: place, name, acc, ash_height_m: ashM,
  observed_at: '2026-10-09T00:00:00Z', polled_at: '2026-10-15T00:00:00Z',
});
const INPUT: VolcanoInput = {
  kvert: [kvert('SHEVELUCH', 'Шивелуч', 'orange', 12000), kvert('AVACHINSKY', 'Авачинский', 'green')],
  kfegsDate: '2026-10-15',
  kfegs: [],
};

describe('вулканы в краевой обстановке', () => {
  it('оранжевый Шивелуч назван строкой get_volcano_status, шкала — отдельная', () => {
    const lines = volcanoLinesForSafetyStatus(INPUT, NOW);
    expect(lines[0]).toBe('Вулканы с повышенной активностью (KVERT, КФ ЕГС) — 1; отдельная шкала, в число предупреждений выше не входит:');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^- Шивелуч: /);
    expect(lines[1]).toContain('пепел до 12.0 км');
    expect(lines[1]).toContain('наблюдение 09.10.2026');
    expect(lines.join('\n')).not.toContain('Авачинский');
  });

  it('повышенных нет — сказано; источник не прочитан — это не «спокойно»', () => {
    const calm: VolcanoInput = { ...INPUT, kvert: [kvert('AVACHINSKY', 'Авачинский', 'green')] };
    expect(volcanoLinesForSafetyStatus(calm, NOW)).toEqual(['Вулканы (KVERT, КФ ЕГС): повышенной активности нет.']);
    expect(volcanoLinesForSafetyStatus({ ...calm, kvert: null }, NOW))
      .toEqual(['Вулканы (KVERT, КФ ЕГС): по доступным данным повышенных нет, но не все источники проверены — это не «все вулканы спокойны».']);
  });

  it('сверх потолка — «и ещё N» со ссылкой на инструмент, не молча', () => {
    const many: VolcanoInput = {
      ...INPUT,
      kvert: Array.from({ length: SAFETY_STATUS_VOLCANO_LIMIT + 1 }, (_, i) => kvert(`V${i}`, `Вулкан ${i}`, 'yellow')),
    };
    const lines = volcanoLinesForSafetyStatus(many, NOW);
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(SAFETY_STATUS_VOLCANO_LIMIT);
    expect(lines).toContain('…и ещё 1 — get_volcano_status.');
  });
});

describe('ответ safety_status целиком', () => {
  const volcanoes = volcanoLinesForSafetyStatus(INPUT, NOW);
  const text = formatSafetyStatusForAgent(STATUS, volcanoes, NOW);
  const lines = text.split('\n');

  it('под каждым пунктом ленты — когда появился и до какого срока', () => {
    const at = (title: string) => lines.indexOf(`- ${title}`);
    expect(lines[at(TITLES[1]) + 1]).toBe('  внесено вручную 3 июля; в ленте до 1 января 2027 г.');
    expect(lines[at(TITLES[2]) + 1]).toBe('  внесено вручную 9 июля; в ленте до 1 июля 2027 г.');
    expect(lines[at(TITLES[0]) + 1]).toBe('  опубликовано 15 октября; в ленте до 16 октября');
  });

  it('остаток и вулканы стоят в ответе; вулканы — после ленты', () => {
    expect(lines).toContain('Остальные 2 — вне ленты туриста: землетрясения — 1, сводки и сообщения — 1.');
    const volcanoAt = lines.indexOf(volcanoes[0]);
    expect(volcanoAt).toBeGreaterThan(lines.indexOf(`- ${TITLES[4]}`));
    expect(lines[volcanoAt + 1]).toMatch(/^- Шивелуч: /);
  });

  it('сверка каналов читает те же пять заголовков: подробности и вулканы — не пункты ленты', () => {
    const facts = parseSafetyText(text);
    expect(facts?.alert_count).toBe(7);
    expect(facts?.feed_count).toBe(5);
    expect(facts?.feed_titles).toEqual(TITLES);
  });

  it('вулканы не прочитаны — сказано словами; тревоги не прочитаны — вулканы всё равно названы', () => {
    expect(formatSafetyStatusForAgent(STATUS, null, NOW))
      .toContain('Вулканы: сводки KVERT и КФ ЕГС прочитать не удалось — это не «спокойно»; по вулканам спросите get_volcano_status.');
    const noAlerts = formatSafetyStatusForAgent(null, volcanoes, NOW);
    expect(noAlerts).toMatch(/^Данных об обстановке сейчас нет — источник недоступен/);
    expect(noAlerts).toContain(volcanoes[0]);
  });

  it('без блока вулканов (старые вызовы) ответ прежний, без лишних строк', () => {
    expect(formatSafetyStatusForAgent(STATUS, undefined, NOW)).not.toContain('Вулканы');
  });
});

describe('статус из базы: даты пунктов и остаток вне ленты', () => {
  // Строки так, как их вернул бы PostgreSQL на запросы getCurrentSafetyStatus.
  // Время у всех строк — стенное UTC (миграция 1269 привела ручные записи к
  // соглашению ингеста), и прочтение у него одно; поведение на настоящем
  // PostgreSQL с поясом сессии +03 держит tests/integration/safety-status-feed.pg.test.ts.
  const FEED_ROWS = [
    { title: TITLES[0], external_id: 'mchs/101', source_url: null, created_iso: '2026-10-14T20:00:00.000Z', expires_iso: '2026-10-15T20:00:00.000Z' },
    // Миграция 718: внесено руками, expires_at — заглушка 2027.
    { title: TITLES[1], external_id: 'manual-vilyuchinsky-pass-2026-07', source_url: 'https://www.ustoym.ru', created_iso: '2026-07-03T02:00:00.000Z', expires_iso: '2027-01-01T00:00:00.000Z' },
    { title: TITLES[2], external_id: 'manual-khalaktyrsky-road-2026-07', source_url: null, created_iso: '2026-07-09T02:00:00.000Z', expires_iso: '2027-07-01T00:00:00.000Z' },
    { title: TITLES[3], external_id: 'mchs/102', source_url: null, created_iso: '2026-10-13T22:00:00.000Z', expires_iso: '2026-10-16T22:00:00.000Z' },
    { title: TITLES[4], external_id: 'kbgs/7', source_url: null, created_iso: '2026-10-14T00:00:00.000Z', expires_iso: '2026-10-21T00:00:00.000Z' },
  ].map((r) => ({ ...r, basis_title: null, basis_url: null, basis_origin: null }));
  // Семь активных: шесть ленточного типа (одна тема дважды — Халактырский из
  // двух лент) и одно землетрясение.
  const BY_TYPE = [
    { alert_type: 'road_closure', n: 3 },
    { alert_type: 'bear', n: 1 },
    { alert_type: 'earthquake', n: 1 },
    { alert_type: 'volcanic_eruption', n: 1 },
    { alert_type: 'weather', n: 1 },
  ];
  const route = (failByType: boolean) => async (sql: string) => {
    if (sql.includes('MAX(severity)')) return { rows: [{ max_severity: '2', active_count: '7' }] };
    if (sql.includes('ORDER BY (title ~* $1)')) return { rows: [{ title: TITLES[0], alert_type: 'weather', external_id: 'mchs/101', source_url: null }] };
    if (sql.includes('FROM location_real_time_status')) return { rows: [{ last_update: '2026-10-15T01:20:00.000Z' }] };
    if (sql.includes('DISTINCT ON (lower(title))')) return { rows: FEED_ROWS };
    if (sql.includes('GROUP BY alert_type')) {
      if (failByType) throw new Error('canceling statement due to statement timeout');
      return { rows: BY_TYPE };
    }
    return { rows: [] };
  };
  const realStatus = async () => {
    const real = await vi.importActual<typeof import('@/lib/safety/current-status')>('@/lib/safety/current-status');
    return real.getCurrentSafetyStatus();
  };

  it('ручная запись узнана по external_id, даты — из строки; остаток разложен на типы и повторы', async () => {
    fx.query = route(false);
    const status = await realStatus();
    expect(status?.feedWhen?.[1]).toEqual({ createdAt: '2026-07-03T02:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', manual: true });
    expect(status?.feedWhen?.[0]).toEqual({ createdAt: '2026-10-14T20:00:00.000Z', expiresAt: '2026-10-15T20:00:00.000Z', manual: false });
    expect(status?.outsideFeed).toEqual({ byType: [{ type: 'earthquake', count: 1 }], repeats: 1 });

    const lines = formatSafetyStatusForAgent(status, undefined, NOW).split('\n');
    expect(lines).toContain('Остальные 2 — вне ленты туриста: землетрясения — 1, повторы уже названной темы — 1.');
    expect(lines[lines.indexOf(`- ${TITLES[1]}`) + 1]).toBe('  внесено вручную 3 июля; в ленте до 1 января 2027 г.');
  });

  it('разбивку не посчитали — лента и общее число на месте, отказ в логе и словами', async () => {
    fx.query = route(true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const status = await realStatus();
    expect(status?.activeCount).toBe(7);
    expect(status?.feedTitles).toEqual(TITLES);
    expect(status?.outsideFeed).toBeNull();
    expect(err).toHaveBeenCalledWith('[current-status] остаток вне ленты не посчитан:', 'canceling statement due to statement timeout');
    expect(formatSafetyStatusForAgent(status, undefined, NOW))
      .toContain('Остальные 2 — вне ленты туриста; разбивку по типам посчитать не удалось.');
    err.mockRestore();
  });
});

describe('инструмент safety_status собирает обе части', () => {
  it('тревоги и вулканы — в одном ответе', async () => {
    fx.status = STATUS;
    fx.volcanoInput = INPUT;
    fx.volcanoFails = false;
    const text = await executeKuzmichTool('safety_status', {}, { surface: 'mcp' });
    expect(text).toContain('Активных предупреждений по Камчатскому краю: 7');
    expect(text).toContain('Остальные 2 — вне ленты туриста');
    expect(text).toContain('Вулканы с повышенной активностью (KVERT, КФ ЕГС) — 1');
    expect(text).toMatch(/\n- Шивелуч: /);
  });

  it('отказ сводок вулканов не гасит тревоги и называется словами', async () => {
    fx.status = STATUS;
    fx.volcanoFails = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = await executeKuzmichTool('safety_status', {}, { surface: 'mcp' });
    expect(text).toContain('Активных предупреждений по Камчатскому краю: 7');
    expect(text).toContain('Вулканы: сводки KVERT и КФ ЕГС прочитать не удалось');
    expect(err).toHaveBeenCalledWith('[safety_status] вулканы не прочитаны:', 'volcano_status недоступна');
    err.mockRestore();
  });
});
