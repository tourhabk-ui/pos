// @vitest-environment node
/**
 * Сторож: воронку можно смотреть за день — и цифры дня честные.
 *
 * ── Что просил владелец (29.09) ───────────────────────────────────────────
 *
 * «Хочу смотреть не только аналитику за 7 дней, но и за день.» Воронка
 * считалась только крон-переписью (скользящее окно в целых сутках, закрытое
 * секретом крона), на странице `/hub/admin/traffic` шагов воронки не было
 * вовсе. Теперь окно — день / вчера / 7 / 30 суток / любые прошлые сутки, а
 * подсчёт один на перепись и страницу (`lib/analytics/funnel-window`).
 *
 * ── Что здесь держится ────────────────────────────────────────────────────
 *
 *  1. Сутки камчатские: 23:59:59 — ещё вчера, 00:00:00 — уже сегодня. Граница
 *     по поясу базы (МСК) или сервера (UTC) делила бы день владельца надвое.
 *  2. Окно не врёт: будущая и несуществующая дата — отказ со словами, а не
 *     пустой день; непонятный запрос — отказ, а не молчаливые «7 суток» под
 *     видом «за день».
 *  3. «Не смог сосчитать» не превращается в ноль — ни в шапке, ни в таблице.
 *  4. Подсчёт один: у переписи и у страницы нет своих запросов.
 *
 * Прогон на настоящем PostgreSQL — tests/integration/funnel-window.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  kamchatkaDate, kamchatkaDayStart, shiftDate, isRealDate, ruShort, fmtKamchatka,
} from '@/lib/analytics/kamchatka-day';
import { resolveFunnelWindow, windowParams, WINDOW_SQL, FUNNEL_RANGES } from '@/lib/analytics/funnel-window';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*--.*$/gm, '');

const LIB = code(read('lib/analytics/funnel-window.ts'));
const CENSUS = code(read('app/api/cron/funnel-census/route.ts'));
const API = code(read('app/api/admin/analytics/funnel-window/route.ts'));
const UI = code(read('app/hub/admin/traffic/_FunnelWindow.tsx'));
const PAGE = code(read('app/hub/admin/traffic/page.tsx'));

/** 17:50 по Камчатке 29.09 (05:50 UTC). */
const NOW = new Date('2026-09-29T05:50:00Z');

describe('сутки — камчатские', () => {
  it('полночь: 23:59:59 — ещё вчера, 00:00:00 — уже сегодня', () => {
    expect(kamchatkaDate(new Date('2026-09-28T11:59:59Z'))).toBe('2026-09-28');
    expect(kamchatkaDate(new Date('2026-09-28T12:00:00Z'))).toBe('2026-09-29');
  });

  it('начало суток — 12:00 UTC предыдущего дня', () => {
    expect(kamchatkaDayStart('2026-09-29').toISOString()).toBe('2026-09-28T12:00:00.000Z');
  });

  it('граница года и високосный день не ломают календарную арифметику', () => {
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDate('2026-09-29', 0)).toBe('2026-09-29');
  });

  it('несуществующая дата — не дата', () => {
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('вчера')).toBe(false);
    expect(isRealDate('2026-09-29')).toBe(true);
  });

  it('подписи по-русски: ДД.ММ и «дата, время» из строки БД', () => {
    expect(ruShort('2026-09-29')).toBe('29.09');
    // 10:14 по МСК — это 19:14 по Камчатке.
    expect(fmtKamchatka('2026-09-29 10:14:02.317308+03')).toBe('29.09 19:14');
    expect(fmtKamchatka('2026-09-29T05:50:00.000Z')).toBe('29.09 17:50');
  });

  it('строка, которую не разобрали, — null, а не «сейчас»', () => {
    expect(fmtKamchatka(null)).toBeNull();
    expect(fmtKamchatka('не время')).toBeNull();
  });
});

describe('окно: что просит человек — то и считается', () => {
  const ok = (input: Parameters<typeof resolveFunnelWindow>[0]) => {
    const r = resolveFunnelWindow(input, NOW);
    if (!r.ok) throw new Error(`ожидалось окно, получено: ${r.error}`);
    return r.window;
  };

  it('сегодня — с камчатской полуночи до сих пор, сутки не закончились', () => {
    const w = ok({ range: 'today' });
    expect(w.from.toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(w.to).toBeNull();
    expect(w.partial).toBe(true);
    expect(w.date).toBe('2026-09-29');
    expect(w.label).toContain('Сегодня');
  });

  it('вчера — целые сутки, верхняя граница — камчатская полночь', () => {
    const w = ok({ range: 'yesterday' });
    expect(w.from.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(w.to?.toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(w.partial).toBe(false);
    expect(w.label).toContain('Вчера');
  });

  it('любая прошлая дата — целые сутки', () => {
    const w = ok({ date: '2026-09-20' });
    expect(w.to!.getTime() - w.from.getTime()).toBe(24 * 3_600_000);
    expect(w.kind).toBe('day');
  });

  it('дата «сегодня» ведёт себя как «сегодня»: сутки идут', () => {
    const w = ok({ date: '2026-09-29' });
    expect(w.to).toBeNull();
    expect(w.partial).toBe(true);
  });

  it('7 и 30 суток — скользящие, визиты названы человеко-днями', () => {
    const w7 = ok({ range: '7d' });
    expect(w7.kind).toBe('rolling');
    expect(w7.days).toBe(7);
    expect(w7.visitor_unit).toBe('visitor_days');
    expect(ok({ range: '30d' }).days).toBe(30);
  });

  it('на одних сутках визиты — люди, на многих — человеко-дни', () => {
    expect(ok({ range: 'today' }).visitor_unit).toBe('people');
    expect(ok({ days: 1 }).visitor_unit).toBe('people');
    expect(ok({ days: 14 }).visitor_unit).toBe('visitor_days');
  });

  it('без параметров — семь суток, как у переписи раньше', () => {
    expect(ok({}).days).toBe(7);
  });

  it('days зажимается в 1..90, а не превращается в отказ или в бесконечность', () => {
    expect(ok({ days: 0 }).days).toBe(1);
    expect(ok({ days: 500 }).days).toBe(90);
    expect(ok({ days: '14' }).days).toBe(14);
  });

  it('за полночь «сегодня» меняется, а не залипает', () => {
    const before = resolveFunnelWindow({ range: 'today' }, new Date('2026-09-28T11:59:59Z'));
    const after = resolveFunnelWindow({ range: 'today' }, new Date('2026-09-28T12:00:00Z'));
    expect(before.ok && before.window.date).toBe('2026-09-28');
    expect(after.ok && after.window.date).toBe('2026-09-29');
  });
});

describe('окно: непонятный запрос — отказ со словами', () => {
  const err = (input: Parameters<typeof resolveFunnelWindow>[0]) => {
    const r = resolveFunnelWindow(input, NOW);
    if (r.ok) throw new Error('ожидался отказ');
    return r.error;
  };

  it('будущая дата — не пустой день, а отказ', () => {
    expect(err({ date: '2026-09-30' })).toMatch(/ещё не наступило/);
  });

  it('несуществующая и нечитаемая даты', () => {
    expect(err({ date: '2026-02-30' })).toMatch(/не дата/);
    expect(err({ date: 'вчера' })).toMatch(/не дата/);
  });

  it('два параметра сразу — отказ: «за день» не подменяется «за неделю»', () => {
    expect(err({ range: 'today', date: '2026-09-01' })).toMatch(/что-то одно/);
    expect(err({ range: '7d', days: 3 })).toMatch(/что-то одно/);
  });

  it('незнакомый период и days не числом', () => {
    expect(err({ range: 'месяц' })).toMatch(/Неизвестный период/);
    expect(err({ days: 'много' })).toMatch(/не число/);
  });

  it('все допустимые периоды перечислены словами в тексте отказа', () => {
    for (const r of FUNNEL_RANGES) expect(err({ range: 'x' })).toContain(r);
  });
});

describe('границы окна в SQL: сутки не пересекаются и не теряют полночь', () => {
  it('нижняя включительно, верхняя — нет, обе параметризованы и приведены', () => {
    expect(WINDOW_SQL).toMatch(/created_at >= \$1::timestamptz/);
    expect(WINDOW_SQL).toMatch(/created_at < \$2::timestamptz/);
    // NULL в $2 — «до сих пор»; без приведения сервер не выведет его тип (42P08).
    expect(WINDOW_SQL).toMatch(/\$2::timestamptz IS NULL/);
  });

  it('параметры — ISO-строки, верхняя граница null у открытого окна', () => {
    const today = resolveFunnelWindow({ range: 'today' }, NOW);
    const yest = resolveFunnelWindow({ range: 'yesterday' }, NOW);
    if (!today.ok || !yest.ok) throw new Error('окна не разобрались');
    expect(windowParams(today.window)).toEqual(['2026-09-28T12:00:00.000Z', null]);
    expect(windowParams(yest.window)).toEqual(['2026-09-27T12:00:00.000Z', '2026-09-28T12:00:00.000Z']);
  });

  it('границы суток не считает база: нет CURRENT_DATE и date_trunc', () => {
    // Сессия БД живёт в МСК, а «сегодня» владельца — камчатское.
    expect(LIB, 'границы суток снова по поясу базы').not.toMatch(/CURRENT_DATE|date_trunc|::date/i);
  });

  it('в тексты запросов подставляются только готовые фрагменты, но не значения', () => {
    // Всё, что меняется от запроса к запросу (границы, дни), идёт параметрами.
    const allowed = new Set(['WINDOW_SQL', 'TOUR_PATH', 'FROM']);
    const sqlStrings = [...LIB.matchAll(/exec\.query<[^`]*?>\(\s*`([^`]*)`/g)].map((m) => m[1]);
    expect(sqlStrings.length, 'запросы не найдены — сторож ослеп').toBeGreaterThan(8);
    for (const sql of sqlStrings) {
      for (const m of sql.matchAll(/\$\{([^}]*)\}/g)) {
        expect(allowed.has(m[1].trim()), `в SQL подставлено «${m[1]}» — значения только параметрами`).toBe(true);
      }
    }
  });

  it('разбивка по суткам — массивами границ, а не поясом сервера', () => {
    expect(LIB).toMatch(/unnest\(\$1::timestamptz\[\], \$2::timestamptz\[\]\) WITH ORDINALITY/);
  });
});

describe('«не смог сосчитать» не превращается в ноль', () => {
  it('замер ловит отказ, пишет в лог и отдаёт причину', () => {
    expect(LIB).toMatch(/console\.error\(`\[funnel-window\] замер/);
  });

  it('ячейка разбивки по суткам — null, когда замер упал или строки нет', () => {
    const daily = LIB.slice(LIB.indexOf('export async function funnelByDay'));
    expect(daily).toMatch(/views\.failed \? null/);
    expect(daily).toMatch(/\?\? null\)/);
    expect(daily, 'пустая строка LEFT JOIN снова читается как ноль').not.toMatch(/\?\? 0\)/);
  });

  it('экран показывает «нет данных» и прочерк, а не 0', () => {
    expect(UI).toMatch(/v === null \? 'нет данных'/);
    expect(UI).toMatch(/v === null \? '—'/);
  });

  it('о неудавшихся замерах экран говорит словами', () => {
    expect(UI).toMatch(/Не удалось сосчитать/);
    expect(UI).toMatch(/daily_failed/);
  });
});

describe('подсчёт один: у переписи и у страницы нет своих запросов', () => {
  it('перепись только разбирает параметры и зовёт общий модуль', () => {
    expect(CENSUS).toMatch(/buildFunnelReport\(resolved\.window\)/);
    expect(CENSUS, 'у переписи снова свой SQL').not.toMatch(/\b(SELECT|FROM page_views|FROM leads)\b/);
  });

  it('админ-эндпоинт зовёт тот же модуль', () => {
    expect(API).toMatch(/buildFunnelReport\(resolved\.window\)/);
    expect(API).toMatch(/funnelByDay\(now, DEFAULT_DAILY_ROWS\)/);
    expect(API, 'у эндпоинта свой SQL').not.toMatch(/\bSELECT\b/);
  });

  it('вердикт выносит судья петли эволюции, своего порога здесь нет', () => {
    expect(LIB).toMatch(/pickFunnelFinding.*from '@\/lib\/agents\/evo\/growth-agent'/s);
    expect(LIB).not.toMatch(/title:\s*'Воронка/);
  });

  it('модуль только читает', () => {
    expect(LIB).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

describe('доступ и разбор входа', () => {
  it('эндпоинт закрыт правом администратора', () => {
    expect(API).toMatch(/requireAdmin\(request\)/);
  });

  it('вход проверяется Zod, а сообщения — по-русски', () => {
    expect(API).toMatch(/z\.object\(/);
    expect(API).toMatch(/Неизвестный период/);
    expect(API).toMatch(/ГГГГ-ММ-ДД/);
  });

  it('без параметров страница открывается на «сегодня»', () => {
    expect(API).toMatch(/range \?\? \(date \? undefined : 'today'\)/);
  });
});

describe('экран', () => {
  it('подключён к странице посещаемости — сироте не быть', () => {
    expect(PAGE).toMatch(/import FunnelWindow from '\.\/_FunnelWindow'/);
    expect(PAGE).toMatch(/<FunnelWindow \/>/);
  });

  it('клиентский код не тянет модуль с базой', () => {
    expect(UI, 'экран импортирует funnel-window, а с ним и пул БД').not.toMatch(/from '@\/lib\/analytics\/funnel-window'/);
    expect(UI).not.toMatch(/db-pool/);
  });

  it('есть все периоды владельца: сегодня, вчера, 7, 30 и выбор дня', () => {
    for (const label of ['Сегодня', 'Вчера', '7 дней', '30 дней']) expect(UI).toContain(`label: '${label}'`);
    expect(UI).toMatch(/type="date"/);
    expect(UI).toMatch(/max=\{today\}/);
  });

  it('ответ на прежний выбор не затирает новый', () => {
    // Отмена в очистке эффекта: устаревший ответ выбрасывается до setState.
    expect(UI).toMatch(/if \(cancelled\) return/);
    expect(UI).toMatch(/return \(\) => \{ cancelled = true; \}/);
  });

  it('загрузка выводится из ключа запроса, а не ставится в теле эффекта', () => {
    expect(UI).toMatch(/const settled = result\?\.key === key/);
    expect(UI).not.toMatch(/setLoading\(/);
  });

  it('между шагами воронки процентов нет: события и люди — разные единицы', () => {
    expect(UI, 'экран снова рисует конверсию между шагами').not.toMatch(/Math\.round\([^)]*\/[^)]*\* ?100/);
    expect(UI).not.toMatch(/конверси/i);
  });

  it('единица «визитов» названа: люди или человеко-дни', () => {
    expect(UI).toMatch(/человеко-дни, не разные люди/);
  });

  it('сутки ещё идут — сказано словами', () => {
    expect(UI).toMatch(/Сутки ещё не закончились/);
  });

  it('таблица по дням не предлагает суммировать столбец визитов', () => {
    expect(UI).toMatch(/суммировать столбец нельзя/);
  });

  it('подписи статусов заявок — из CRM, второго словаря нет', () => {
    expect(UI).toMatch(/import \{ STATUS_META \} from '@\/app\/hub\/admin\/leads\/_LeadsClient'/);
  });

  it('эмодзи и запрещённые классы не использованы', () => {
    expect(UI).not.toMatch(/font-black|text-white|bg-white\/|rounded-2xl/);
    expect(UI).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
