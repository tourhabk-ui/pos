/**
 * Лента отдельных бюллетеней KVERT VONA (type=6) — между недельными сводками.
 *
 * Повод (08.10): у всех вулканов стояло «6 дней назад», а понижение Чикурачки
 * до зелёного 05.10 не дошло вовсе. Читалась только недельная сводка; лента
 * бюллетеней пишется сокращённым форматом ICAO («NOTICE TO AVIATION», DTG,
 * CURRENT COLOUR CODE), и прежний парсер его не узнавал.
 *
 * Фикстуры — бюллетени, снятые пробой kvert-probe run 5–6 (08.10) с
 * http://kvert.febras.net/van/?vn=161..163, построчно, в HTML-обёртке, как их
 * отдаёт страница. Единственная синтетика — выпуск 160 (подписан ниже).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { parseVonaFeed, latestVonaNumber } from '@/lib/services/safety/kvert-vona';
import { describeVonaRu } from '@/lib/services/safety/kvert-activity-ru';
import { fetchVonaSince, mergeVonaOverSummary, composeVolcanoRecord } from '@/lib/agents/kvert-sync';
import type { ParsedVona, KvertActivitySection } from '@/lib/services/safety/kvert-vona';

function page(lines: string[], vn: number): string {
  return [
    '<html><body><div class="banner2">KVERT Information Releases</div>',
    '<a href="/van/index.php?type=6&lend=en">KVERT VONA</a>',
    `<a href="/van/index.php?vn=${vn}&lend=en&lang=en" title="Язык">EN</a>`,
    '<pre>',
    lines.join('<br>\n'),
    '</pre>',
    '<p>CITATION GUIDELINES</p>',
    '<p>For formal scientific citation of this KVERT/VONA, please use the following:</p>',
    `<p>KVERT Volcano Observatory Notice for Aviation (VONA). октября 05, 2026. KVERT, Institute of Volcanology and Seismology FEB RAS. URL: http://kvert.febras.net/van/?vn=${vn}.</p>`,
    '<p>Aviation Colour Codes</p><p>GREEN</p><p>Volcano is in normal, non-eruptive state</p>',
    '<p>October</p><p>Oct 05, 22:16 UTC Chikurachki</p><p>Oct 05, 00:06 UTC Sheveluch</p>',
    '</body></html>',
  ].join('\n');
}

const SHEVELUCH_162 = page([
  'VOLCANO OBSERVATORY NOTICE TO AVIATION (VONA)',
  'WMRA01 RUVX 050006',
  'VONA',
  'DTG: 20261005/0006Z',
  'VOLCANO: SHEVELUCH 300270',
  'PSN: N5638 E16119',
  'AREA: RUSSIAN FEDERATION',
  'SOURCE ELEV: 2500M AMSL',
  'NOTICE NR: 2026/30',
  'CURRENT COLOUR CODE: ORANGE',
  'PREVIOUS COLOUR CODE: ORANGE',
  'SVO: KVERT',
  'ACT STS: ERUPTION ONGOING',
  'ONSET: 20261004/2210Z',
  'DUR: 5 MIN',
  'VA CLD HGT: 6500M AMSL',
  'HGT SOURCE: VIDEO DATA',
  'MOV: NE',
  'RMK: EXPLOSION SENT ASH UP TO 6.5KM ASL, ASH CLOUD MOVED 20KM TO NE OF THE VOLCANO',
  'NXT NOTICE: A NEW VONA WILL BE ISSUED IF COND CHANGE SIGNIFICANTLY OR IF THE COLOUR CODE CHANGES.',
], 162);

const SHEVELUCH_161 = page([
  'VOLCANO OBSERVATORY NOTICE TO AVIATION (VONA)',
  'WMRA01 RUVX 032054',
  'VONA',
  'DTG: 20261003/2054Z',
  'VOLCANO: SHEVELUCH 300270',
  'PSN: N5638 E16119',
  'AREA: RUSSIAN FEDERATION',
  'SOURCE ELEV: 2500M AMSL',
  'NOTICE NR: 2026/29',
  'CURRENT COLOUR CODE: ORANGE',
  'PREVIOUS COLOUR CODE: ORANGE',
  'SVO: KVERT',
  'ACT STS: ERUPTION ONGOING',
  'ONSET: NIL',
  'DUR: NIL',
  'VA CLD HGT: NO VA CLD PRODUCED',
  'HGT SOURCE: NO VA CLD PRODUCED',
  'MOV: NO VA CLD PRODUCED',
  'RMK: EXTRUSIVE ERUPTION OF VOLCANO CONT. SATELLITE DATA BY KVERT SHOWED A THERMAL ANOMALY ON VOLCANO ALL WEEK.',
  'NXT NOTICE: A NEW VONA WILL BE ISSUED IF COND CHANGE SIGNIFICANTLY OR IF THE COLOUR CODE CHANGES.',
], 161);

// Строки, которые проба показала у выпуска 163; прочих полей в фикстуре нет.
const CHIKURACHKI_163 = page([
  'VOLCANO OBSERVATORY NOTICE TO AVIATION (VONA)',
  'WMRA01 RUVX 052216',
  'VONA',
  'DTG: 20261005/2216Z',
  'VOLCANO: CHIKURACHKI 290360',
  'PSN: N5019 E15528',
  'SOURCE ELEV: 1816M AMSL',
  'NOTICE NR: 2026/29',
  'CURRENT COLOUR CODE: GREEN',
  'PREVIOUS COLOUR CODE: YELLOW',
  'SVO: KVERT',
  'ACT STS: DECREASED UNREST',
  'ONSET: NIL',
  'RMK: LAST EXPLOSIVE ACTIVITY WAS ON SEP 20',
  'NXT NOTICE: A NEW VONA WILL BE ISSUED IF COND CHANGE SIGNIFICANTLY OR IF THE COLOUR CODE CHANGES.',
], 163);

// СИНТЕТИКА: выпуск 161 с датой 28.09 — бюллетень старше сводки 02.10.
const OLDER_160 = SHEVELUCH_161.replace('DTG: 20261003/2054Z', 'DTG: 20260928/2159Z').replace(/vn=161/g, 'vn=160');

describe('parseVonaFeed: сокращённый формат ICAO', () => {
  it('разбирает бюллетень Шивелуча 05.10 со страницы KVERT', () => {
    const [v, ...rest] = parseVonaFeed(SHEVELUCH_162);
    expect(rest).toHaveLength(0);
    expect(v.volcanoName).toBe('SHEVELUCH');
    expect(v.nameSlug).toBe('sheveluch');
    expect(v.color).toBe('orange');
    expect(v.previousColor).toBe('orange');
    expect(v.ashHeightM).toBe(6500);
    expect(v.noticeNumber).toBe('2026/30');
    expect(v.observedAt?.toISOString()).toBe('2026-10-05T00:06:00.000Z');
    expect(v.summary).toMatch(/^EXPLOSION SENT ASH UP TO 6\.5KM/);
  });

  it('«NO VA CLD PRODUCED» — высоты нет, а не ноль', () => {
    const [v] = parseVonaFeed(SHEVELUCH_161);
    expect(v.ashHeightM).toBeNull();
  });

  it('понижение Чикурачки: зелёный из жёлтого', () => {
    const [v] = parseVonaFeed(CHIKURACHKI_163);
    expect(v.nameSlug).toBe('chikurachki');
    expect(v.color).toBe('green');
    expect(v.previousColor).toBe('yellow');
  });

  it('легенда и архив после правил цитирования не разбираются как бюллетень', () => {
    // В цитате стоит «Notice for Aviation» — прежний разделитель. Блок после
    // неё полей бюллетеня не несёт и в выдачу попасть не должен.
    expect(parseVonaFeed(CHIKURACHKI_163)).toHaveLength(1);
  });

  it('номер последнего выпуска — из ссылок страницы', () => {
    expect(latestVonaNumber(CHIKURACHKI_163)).toBe(163);
    expect(latestVonaNumber('<html>нет ссылок</html>')).toBeNull();
  });
});

describe('fetchVonaSince: назад от последнего, пока не старше сводки', () => {
  const pages: Record<string, string> = {
    'http://kvert.febras.net/van/index.php?type=6&lend=en': CHIKURACHKI_163,
    'http://kvert.febras.net/van/?vn=162&lend=en': SHEVELUCH_162,
    'http://kvert.febras.net/van/?vn=161&lend=en': SHEVELUCH_161,
    'http://kvert.febras.net/van/?vn=160&lend=en': OLDER_160,
  };

  it('берёт выпуски новее сводки и останавливается на первом старше', async () => {
    const asked: string[] = [];
    const get = async (u: string) => { asked.push(u); return pages[u] ?? null; };
    const r = await fetchVonaSince(new Date('2026-10-02T23:53:00Z'), get);
    expect(r.latest).toBe(163);
    expect(r.items.map((v) => v.noticeNumber)).toEqual(['2026/29', '2026/30', '2026/29']);
    expect(r.items.map((v) => v.nameSlug)).toEqual(['chikurachki', 'sheveluch', 'sheveluch']);
    expect(r.items[0].sourceUrl).toBe('http://kvert.febras.net/van/?vn=163&lend=en');
    // Последний выпуск уже на странице ленты: второй раз его не качаем.
    expect(asked).not.toContain('http://kvert.febras.net/van/?vn=163&lend=en');
    // 160 прочитан, увидено, что он старше сводки, — дальше не идём.
    expect(asked).not.toContain('http://kvert.febras.net/van/?vn=159&lend=en');
    expect(r.read).toBe(4);
    expect(r.failed).toEqual([]);
  });

  it('недоступный промежуточный выпуск назван, остальные прочитаны', async () => {
    const get = async (u: string) => {
      if (u.includes('vn=162')) throw new Error('timeout');
      return pages[u] ?? null;
    };
    const r = await fetchVonaSince(new Date('2026-10-02T23:53:00Z'), get);
    expect(r.failed).toEqual([162]);
    expect(r.items.map((v) => v.noticeNumber)).toEqual(['2026/29', '2026/29']);
    expect(r.truncated).toBe(false);
  });

  it('потолок раньше старого бюллетеня — сказано, что дальше не смотрели', async () => {
    const r = await fetchVonaSince(new Date('2026-01-01T00:00:00Z'), async (u) => pages[u] ?? null);
    expect(r.items).toHaveLength(4);
    expect(r.failed).toEqual([159, 158, 157, 156]);
    expect(r.truncated).toBe(true);
  });

  it('лента не ответила — отказ, а не «бюллетеней нет»', async () => {
    await expect(fetchVonaSince(null, async () => null)).rejects.toThrow(/лента VONA/);
  });
});

describe('mergeVonaOverSummary: по вулкану — более свежее наблюдение', () => {
  const summary = (slug: string, name: string, color: ParsedVona['color']): ParsedVona => ({
    volcanoName: name, nameSlug: slug, nameRu: null, color, previousColor: null,
    summitElevationM: null, ashHeightM: null, area: null, noticeNumber: null,
    observedAt: new Date('2026-10-02T23:53:00Z'), summary: null,
  });

  it('свежий бюллетень перебивает сводку, старый по тому же вулкану — нет', () => {
    const vonas = [
      ...parseVonaFeed(CHIKURACHKI_163),
      ...parseVonaFeed(SHEVELUCH_162),
      ...parseVonaFeed(SHEVELUCH_161),
    ];
    const { merged, applied } = mergeVonaOverSummary(
      [summary('chikurachki', 'CHIKURACHKI', 'yellow'), summary('sheveluch', 'SHEVELUCH', 'orange'), summary('klyuchevskoy', 'KLYUCHEVSKOY', 'yellow')],
      vonas,
    );
    const by = new Map(merged.map((v) => [v.nameSlug, v]));
    expect(by.get('chikurachki')?.color).toBe('green');
    expect(by.get('sheveluch')?.noticeNumber).toBe('2026/30');
    // Вулкан без бюллетеня остаётся со сводкой.
    expect(by.get('klyuchevskoy')?.color).toBe('yellow');
    expect(applied).toEqual(['CHIKURACHKI', 'SHEVELUCH']);
  });

  it('бюллетень без даты сводку не перебивает', () => {
    const [v] = parseVonaFeed(CHIKURACHKI_163);
    const { merged, applied } = mergeVonaOverSummary([summary('chikurachki', 'CHIKURACHKI', 'yellow')], [{ ...v, observedAt: null }]);
    expect(merged[0].color).toBe('yellow');
    expect(applied).toEqual([]);
  });
});

describe('describeVonaRu: фраза только из полей бюллетеня', () => {
  it('смена кода и наблюдённое облако', () => {
    expect(describeVonaRu(parseVonaFeed(CHIKURACHKI_163)[0])).toBe('Код KVERT понижен с жёлтого до зелёного.');
    expect(describeVonaRu(parseVonaFeed(SHEVELUCH_162)[0])).toBe('Облако пепла поднималось до 6,5 км над уровнем моря.');
  });

  it('без смены кода и без облака — нечего сказать', () => {
    expect(describeVonaRu(parseVonaFeed(SHEVELUCH_161)[0])).toBeNull();
  });
});

describe('composeVolcanoRecord: бюллетень не занижает предупреждение сводки', () => {
  // Раздел недельной сводки 02.10 по Шивелучу — абзацы с выпуска (probe run 5).
  const sheveluchWeekly: KvertActivitySection = {
    volcanoName: 'SHEVELUCH', nameSlug: 'sheveluch', nameRu: 'Шивелуч', color: 'orange',
    summitElevationM: 3283, ashHeightM: 12000,
    hazardEn: 'An explosive-extrusive eruption of the volcano continues. Ash explosions up to 12 km (39,400 ft) a.s.l. could occur at any time. Ongoing activity could affect international and low-flying aircraft.',
    activityEn: 'An explosive-extrusive eruption of the volcano continues, accompanied by powerful gas-steam activity; a new block of lava continues to grow in the northern part of the lava dome.',
    sourceUrl: 'http://kvert.febras.net/volc?lang=en&name=Sheveluch',
  };
  const chikurachkiWeekly: KvertActivitySection = {
    volcanoName: 'CHIKURACHKI', nameSlug: 'chikurachki', nameRu: 'Чикурачки', color: 'yellow',
    summitElevationM: 1816, ashHeightM: 4000,
    hazardEn: 'Moderate activity of the volcano continues. Ash explosions up to 4 km (13,100 ft) a.s.l. could occur at any time.',
    activityEn: 'Satellite data showed an ash plume on September 20.',
    sourceUrl: 'http://kvert.febras.net/volc?lang=en&name=Chikurachki',
  };

  it('код тот же: высота — предупреждение сводки (12 км), а не наблюдённые 6,5', () => {
    const v = parseVonaFeed(SHEVELUCH_162)[0];
    const r = composeVolcanoRecord({ v, vonaSource: 'http://kvert.febras.net/van/?vn=162&lend=en', weeklyColor: 'orange', section: sheveluchWeekly });
    expect(r.ashHeightM).toBe(12000);
    // Каждая фраза со своей цифрой: предупреждение — 12 км, событие — 6,5 км.
    expect(r.summary).toMatch(/12 км над уровнем моря возможны в любое время/);
    expect(r.summary).toMatch(/Облако пепла поднималось до 6,5 км/);
    expect(r.summary).not.toMatch(/6,5 км над уровнем моря возможны/);
    expect(r.activityLevel).toMatch(/^EXPLOSION SENT ASH/);
    expect(r.sourceUrl).toBe('http://kvert.febras.net/van/?vn=162&lend=en');
  });

  it('наблюдённый выброс выше предупреждения — берётся он', () => {
    const v = { ...parseVonaFeed(SHEVELUCH_162)[0], ashHeightM: 15000 };
    const r = composeVolcanoRecord({ v, vonaSource: 'x', weeklyColor: 'orange', section: sheveluchWeekly });
    expect(r.ashHeightM).toBe(15000);
  });

  it('код сменился: описание сводки устарело целиком', () => {
    const v = parseVonaFeed(CHIKURACHKI_163)[0];
    const r = composeVolcanoRecord({ v, vonaSource: 'x', weeklyColor: 'yellow', section: chikurachkiWeekly });
    expect(r.ashHeightM).toBeNull();
    expect(r.summary).toBe('Код KVERT понижен с жёлтого до зелёного.');
  });

  it('у бюллетеня нет поля «прежний код» — решает цвет сводки', () => {
    const v = { ...parseVonaFeed(CHIKURACHKI_163)[0], previousColor: null };
    const r = composeVolcanoRecord({ v, vonaSource: 'x', weeklyColor: 'yellow', section: chikurachkiWeekly });
    expect(r.ashHeightM).toBeNull();
    expect(r.summary).toBeNull();
  });

  it('без бюллетеня — как раньше: высота и фраза сводки', () => {
    const v: ParsedVona = {
      volcanoName: 'SHEVELUCH', nameSlug: 'sheveluch', nameRu: 'Шивелуч', color: 'orange', previousColor: null,
      summitElevationM: null, ashHeightM: null, area: null, noticeNumber: null,
      observedAt: new Date('2026-10-02T23:53:00Z'), summary: null,
    };
    const r = composeVolcanoRecord({ v, vonaSource: null, weeklyColor: 'orange', section: sheveluchWeekly });
    expect(r.ashHeightM).toBe(12000);
    expect(r.summary).toMatch(/^Продолжается эксплозивно-экструзивное извержение/);
    expect(r.activityLevel).toMatch(/^An explosive-extrusive eruption/);
    expect(r.sourceUrl).toBe('http://kvert.febras.net/volc?lang=en&name=Sheveluch');
  });
});
