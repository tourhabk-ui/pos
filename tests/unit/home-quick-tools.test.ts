/**
 * Плитки «Планировщик» и «Радар» на главной (владелец 25.09: «планировщик
 * модной иконкой и радар модной иконкой, нужно экономить место на мобильной»).
 *
 * Сжимается вид, а не утверждение. Сторож держит:
 * 1. короткие подписи говорят то же, что полные: три состояния свежести,
 *    «не посчитано» у покрытия — своим словом, а не нулём;
 * 2. обе плитки в одном ряду и обе ведут туда же, куда вели карточки;
 * 3. полная строка приборов остаётся в aria-label — диктор читает всё.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataFreshness, freshnessShort, humanAgeShort,
} from '@/lib/home/data-freshness';

const HOME = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
const DATA = readFileSync(join(process.cwd(), 'app/_home/data.ts'), 'utf-8');
const NOW = new Date('2026-09-25T06:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe('короткие подписи', () => {
  it('возраст коротко', () => {
    expect(humanAgeShort(0)).toBe('только что');
    expect(humanAgeShort(5)).toBe('5 мин назад');
    expect(humanAgeShort(9 * 60 + 10)).toBe('9 ч назад');
    expect(humanAgeShort(50 * 60)).toBe('2 дн назад');
  });

  it('свежесть — возраст; «свежо/устарело» несёт точка, «не знаем» — словами', () => {
    expect(freshnessShort(dataFreshness({ updatedAt: ago(20), source: 'safety', now: NOW }))).toBe('20 мин назад');
    expect(freshnessShort(dataFreshness({ updatedAt: ago(9 * 60), source: 'safety', now: NOW }))).toBe('9 ч назад');
    expect(freshnessShort(dataFreshness({ updatedAt: null, now: NOW }))).toBe('нет данных');
  });

  it('короткие подписи не длиннее 16 знаков — столько входит в плитку на 360px', () => {
    const samples = [
      freshnessShort(dataFreshness({ updatedAt: ago(59), now: NOW })),
      freshnessShort(dataFreshness({ updatedAt: ago(23 * 60), now: NOW })),
      freshnessShort(dataFreshness({ updatedAt: ago(40 * 24 * 60), now: NOW })),
    ];
    for (const t of samples) expect(t.length, t).toBeLessThanOrEqual(16);
  });
});

describe('плитки на главной', () => {
  const tools = HOME.slice(HOME.indexOf('<nav className="qtools qt-top"'), HOME.indexOf('</nav>', HOME.indexOf('<nav className="qtools qt-top"')));

  it('плитки рядами, а не полноширинными карточками', () => {
    expect(tools).not.toBe('');
    // С 10.10 сетка в шесть долей: верхние плитки — по половине (span 3),
    // три двери «Туры / Трансфер / Жильё» — по трети (span 2). Полноширинной
    // карточки по-прежнему нет.
    expect(HOME).toMatch(/\.v7 \.qtools\{[^}]*grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
    expect(HOME).toMatch(/\.v7 \.qtools > \.qt\{grid-column:span 3\}/);
    expect(HOME).not.toMatch(/grid-column:1 ?\/ ?-1|grid-column:span 6/);
    expect(HOME).not.toMatch(/className="planline"|<section className="live">/);
  });

  it('планировщик ведёт в /planner, радар — прямо на радар /safety#radar (владелец 26.09, вечер)', () => {
    expect(tools).toMatch(/href="\/planner" className="qt qt-plan"/);
    // Утром 26.09 плитка раскрывала сводку (вариант 1), вечером владелец:
    // «по кнопке радар должен открываться наш радар» и «сводка и
    // безопасность дублируется?». Плитка — ссылка, раскрывашки и сводки нет.
    expect(tools).toMatch(/<Link\s+href="\/safety#radar"\s+className="qt qt-radar"/);
    expect(HOME).not.toMatch(/radarOpen|id="radar-panel"|radarAlertsLine|radarVolcanoLine/);
  });

  it('полная строка свежести — в aria-label радара, а не только сокращение', () => {
    expect(tools).toContain('aria-label={`Радар обстановки. ${fresh.label}`}');
  });

  it('«офлайн 74%» снято с плитки радара (владелец 03.10)', () => {
    expect(tools).not.toMatch(/coverage|qt-cov|офлайн \d/);
    expect(HOME).not.toMatch(/geometryCoverage|coverageShort|coverageDot/);
  });

  it('иконки — lucide, без эмодзи', () => {
    expect(tools).toContain('<CalendarDays');
    expect(tools).toContain('<Radar');
    expect(tools).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('радар зелёный, но цвет не выдаёт себя за состояние (владелец 26.09)', () => {
  it('плитка и иконка радара — в --success', () => {
    expect(HOME).toMatch(/\.v7 \.qt-radar\{background:color-mix\(in srgb,var\(--success\)/);
    expect(HOME).toMatch(/\.v7 \.qt-radar \.qt-ic\{color:color-mix\(in srgb,var\(--success\)/);
  });

  it('состояние по-прежнему несёт точка свежести, а не зелень плитки', () => {
    expect(HOME).toContain('freshnessDot(fresh.state)');
    // «нет данных» — контур без заливки, а не зелёная точка.
    expect(HOME).toMatch(/: \{ border: '1px solid var\(--text-muted\)', background: 'var\(--bg-card\)' \}/);
  });
});

describe('счёт предупреждений на главной', async () => {
  const { alertsCountLabel, HOME_ALERTS_LIMIT } = await import('@/lib/home/radar-summary');
  it('на потолке выборки — «N и больше», а не ровно N', () => {
    expect(alertsCountLabel(HOME_ALERTS_LIMIT)).toBe(`${HOME_ALERTS_LIMIT} и больше`);
    expect(alertsCountLabel(2)).toBe('2');
  });
});

describe('чипы интересов — один ряд (владелец 25.09: «занимают 2 строчки, не экономно»)', () => {
  it('сетка на столько колонок, сколько чипов у логики, без переноса и без числа в CSS', () => {
    const rule = /\.v7 \.hero-chips\{([^}]*)\}/.exec(HOME)?.[1] ?? '';
    expect(rule).toContain('grid-auto-flow:column');
    expect(rule).toContain('grid-auto-columns:minmax(0,1fr)');
    expect(rule).not.toMatch(/flex-wrap:wrap|grid-template-columns/);
  });

  it('подпись в одну строку, зона нажатия не меньше 44px', () => {
    expect(HOME).toMatch(/\.v7 \.hchip\{[^}]*min-height:56px/);
    expect(HOME).toMatch(/\.v7 \.hchip \.hc-l\{[^}]*white-space:nowrap/);
    expect(HOME).toContain('<span className="hc-l">{c.label}</span>');
  });

  it('у каждого чипа свой цвет стихии — токеном, не серый (владелец 26.09: «посвети кнопки»)', async () => {
    const { INTENT_CHIPS } = await import('@/lib/home/intent-chips');
    const tones = /const CHIP_TONE: Record<string, string> = \{([\s\S]*?)\};/.exec(HOME)?.[1] ?? '';
    for (const c of INTENT_CHIPS) expect(tones, c.key).toMatch(new RegExp(`${c.key}: 'var\\(--[a-z-]+\\)'`));
    expect(HOME).toMatch(/\.v7 \.hchip svg\{color:var\(--hc,/);
    expect(HOME).toMatch(/\.v7 \.hchip\{background:color-mix\(in srgb,var\(--hc,/);
  });
});

describe('полевые инструменты — сеткой 2×2 (владелец 25.09: «место жалко на главной»)', () => {
  const at = HOME.indexOf('<nav className="qtools stools"');
  const grid = at === -1 ? '' : HOME.slice(at, HOME.indexOf('</nav>', at));

  it('четыре плитки в секции #radar, а не четыре полноширинные строки', () => {
    expect(grid).not.toBe('');
    expect((grid.match(/className="qt(?: mchsline)?"/g) ?? []).length).toBe(4);
    expect(HOME).not.toMatch(/className="protoline|className="reportbtn/);
    const radar = HOME.slice(HOME.indexOf('id="radar"'), HOME.indexOf('</section>', HOME.indexOf('id="radar"')));
    expect(radar).toContain('<nav className="qtools stools"');
  });

  it('навигатор и наблюдение — жёсткие ссылки <a> (офлайн грузит закэшированную страницу)', () => {
    expect(grid).toMatch(/<a\s+href="\/planning\?mode=trail"/);
    expect(grid).toMatch(/<a\s+href="\/planning\?mode=trail&obs=1"/);
  });

  it('полная фраза каждой плитки — в aria-label, короткая подпись не длиннее 16 знаков', () => {
    expect((grid.match(/aria-label="[^"]{20,}"/g) ?? []).length).toBe(4);
    const captions = [...grid.matchAll(/<b>[^<]+<\/b><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(captions).toHaveLength(4);
    for (const c of captions) expect(c.length, c).toBeLessThanOrEqual(16);
  });
});

describe('строки поиска на главной нет (владелец 25.09: «поиск лишний — открывает то, что и так открывается»)', () => {
  it('ни формы поиска, ни перехода /routes?q=', () => {
    expect(HOME).not.toMatch(/<form className="find"|role="search"/);
    expect(HOME).not.toContain('/routes?q=');
    expect(HOME).not.toMatch(/\.v7 \.find\b/);
  });
});

describe('один поток, а не две двери (владелец 25.09: «мы нагромождаем»)', () => {
  it('блоков «Тур с оператором» / «Сам по маршруту» нет — поездка смешивает роды дня', () => {
    expect(HOME).not.toMatch(/lg-tour|lg-self|Тур с оператором<\/h2>|Сам по маршруту<\/h2>/);
  });

  it('планировщик и радар над «Турами сезона», затем лента туров, затем чипы (владелец 26.09, 30.09)', () => {
    const tools = HOME.indexOf('<nav className="qtools qt-top" aria-label="Инструменты поездки">');
    const first = HOME.indexOf('className="plates more-tours"');
    const chips = HOME.indexOf('{intentChips}');
    expect(tools).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(tools);
    expect(chips).toBeGreaterThan(first);
    expect(HOME).toMatch(/\{INTENT_CHIPS\.map\(/);
  });
});
