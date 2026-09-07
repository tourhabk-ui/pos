/**
 * Подробности вулкана берутся из выпуска, а не сочиняются.
 *
 * Владелец 06.09: на вкладке «Вулканы» у всех кодов пусто — ни высоты пепла,
 * ни слова о том, что происходит. Сводная таблица кодов их и правда не
 * содержит; разделы активности того же выпуска — содержат.
 *
 * Фикстура — настоящий текст, снятый пробой с раннера 06.09 (kvert-probe
 * run 1). Выдуманный формат проверял бы, что мы согласны сами с собой.
 *
 * Русская фраза собирается разговорником (kvert-activity-ru), а не моделью:
 * `lend=ru` отдаёт тот же английский текст (проба run 2), а на экране
 * безопасности выдуманное слово дороже отсутствующего.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseActivitySections, parseAccSummary } from '@/lib/services/safety/kvert-vona';
import { describeActivityRu } from '@/lib/services/safety/kvert-activity-ru';

/** Куски выпуска от 06.09.2026, как они приходят по проводу. */
const RELEASE = `
<b>SUMMARY OF AVIATION COLOUR CODES:</b><br />
 <b>KAMCHATKA</b><br />
SHEVELUCH, KLYUCHEVSKOY: <span id='ORANGE'>ORANGE</span><br />
BEZYMIANNY, KRASHENINNIKOV: <span id='YELLOW'>YELLOW</span><br />
<br />
SHEVELUCH VOLCANO (CAVW #300270)<br />
<br />
56.64 N, 161.32 E; Elevation 3283 m (10768 ft), the dome elevation ~2500 m (8200 ft)<br />
<br />
Aviation Colour Code is  ORANGE<br />
<br />
The explosive-extrusive eruption of the volcano continues. Ash explosions up to 12 km (39,400 ft) a.s.l. could occur at any time. Ongoing activity could affect international and low-flying aircraft.<br />
<br />
The explosive-extrusive eruption of the volcano continues, accompanied by powerful gas-steam activity; a new block of lava continues to grow in the northern part of the lava dome. Satellite data by KVERT showed a thermal anomaly on the volcano on 28-29 August, and 02-03 September, the volcano was obscured by clouds in the other days of the week.<br />
<br />
http://kvert.febras.net/volc?lang=en&name=Sheveluch<br />
<br />
KLYUCHEVSKOY VOLCANO (CAVW #300260)<br />
<br />
56.06 N, 160.64 E; Elevation 4750 m (15580 ft)<br />
<br />
Aviation Colour Code is  ORANGE<br />
<br />
The moderate explosive eruption of the volcano continues. Ash explosions up to 8 km (26,200 ft) a.s.l. could occur at any time. Ongoing activity could affect low-flying aircraft.<br />
<br />
The summit explosive eruption (Strombolian activity) of the volcano continues. According to KVERT video data, on 28-30 August, separate explosions of the volcano with ash removal up to 7 km a.s.l. were observed. Satellite data by KVERT showed a thermal anomaly on the volcano all week; ash plumes extended for 200 km to the eastern directions of the volcano on 28-30 August.<br />
<br />
http://kvert.febras.net/volc?lang=en&name=Klyuchevskoy<br />
<br />
KRASHENINNIKOV VOLCANO (CAVW #300190)<br />
<br />
54.6 N, 160.27 E; Elevation 1856 m (6088 ft)<br />
<br />
Aviation Colour Code is  YELLOW<br />
<br />
The effusive eruption of the volcano continues. The danger of ash explosions up to 6 km (19,700 ft) a.s.l. remains. Ongoing activity could affect low-flying aircraft.<br />
<br />
The effusive eruption of the volcano continues: lava flows are effusing to the eastern slope of the Northern Cone of the volcano, and a gas-steam emission from this Cone is observing. Satellite data by KVERT showed a big thermal anomaly on the volcano all week.<br />
<br />
http://kvert.febras.net/volc?lang=en&name=Krasheninnikov<br />
<br />
BEZYMIANNY VOLCANO (CAVW #300250)<br />
<br />
55.97 N, 160.6 E; Elevation 2882 m (9453 ft)<br />
<br />
Aviation Colour Code is  YELLOW<br />
<br />
The effusive eruption of the volcano continues. Ongoing activity could affect low-flying aircraft.<br />
<br />
The effusive eruption of the volcano continues, a gas-steam activity of the volcano accompanied this process. Satellite data by KVERT showed a thermal anomaly on the volcano all week.<br />
<br />
http://kvert.febras.net/volc?lang=en&name=Bezymianny<br />
`;

const sections = parseActivitySections(RELEASE);
const by = (slug: string) => sections.find((s) => s.nameSlug === slug);

describe('разделы активности разбираются по настоящему выпуску', () => {
  it('найдены все вулканы и опознаны по-русски', () => {
    expect(sections.length).toBe(4);
    expect(by('sheveluch')?.nameRu).toBe('Шивелуч');
    expect(by('klyuchevskoy')?.nameRu).toBe('Ключевской');
    expect(by('bezymianny')?.nameRu).toBe('Безымянный');
  });

  it('высота пепла приходит километрами, а хранится метрами', () => {
    expect(by('sheveluch')?.ashHeightM).toBe(12000);
    expect(by('klyuchevskoy')?.ashHeightM).toBe(8000);
  });

  it('высота вершины и код читаются из той же секции', () => {
    expect(by('klyuchevskoy')?.summitElevationM).toBe(4750);
    expect(by('klyuchevskoy')?.color).toBe('orange');
    expect(by('bezymianny')?.color).toBe('yellow');
  });

  it('ссылка ведёт на карточку этого вулкана, а не на выпуск целиком', () => {
    expect(by('sheveluch')?.sourceUrl).toContain('name=Sheveluch');
    expect(by('klyuchevskoy')?.sourceUrl).toContain('name=Klyuchevskoy');
  });

  it('у извержения без выброса высоты нет — и она не выдумывается', () => {
    // У Безымянного в прогнозе про пепел не сказано ни слова.
    expect(by('bezymianny')?.ashHeightM).toBeNull();
  });

  it('сводка кодов из того же текста по-прежнему разбирается', () => {
    const codes = parseAccSummary(RELEASE);
    expect(codes.find((c) => c.nameSlug === 'sheveluch')?.color).toBe('orange');
    expect(codes.find((c) => c.nameSlug === 'krasheninnikov')?.color).toBe('yellow');
  });
});

describe('русская фраза собирается из формул, а не пересказывается', () => {
  it('Шивелуч: тип извержения и высота выброса', () => {
    const s = by('sheveluch')!;
    const ru = describeActivityRu({ hazardEn: s.hazardEn, activityEn: s.activityEn, ashHeightM: s.ashHeightM });
    expect(ru).toBe('Продолжается эксплозивно-экструзивное извержение. Пепловые взрывы до 12 км над уровнем моря возможны в любое время.');
  });

  it('Ключевской: умеренное эксплозивное, 8 км', () => {
    const s = by('klyuchevskoy')!;
    const ru = describeActivityRu({ hazardEn: s.hazardEn, activityEn: s.activityEn, ashHeightM: s.ashHeightM });
    expect(ru).toContain('умеренное эксплозивное извержение');
    expect(ru).toContain('до 8 км');
  });

  it('Безымянный: эффузивное извержение и НИ СЛОВА про пепел', () => {
    const s = by('bezymianny')!;
    const ru = describeActivityRu({ hazardEn: s.hazardEn, activityEn: s.activityEn, ashHeightM: s.ashHeightM })!;
    expect(ru).toBe('Продолжается эффузивное извержение.');
    expect(ru).not.toMatch(/пепл/i);
  });

  it('шлейф за 200 км не превращается в высоту выброса', () => {
    // «ash plumes extended for 200 km» — про длину шлейфа. Прочитать это как
    // высоту значило бы объявить выброс в стратосферу.
    const ru = describeActivityRu({
      hazardEn: 'The moderate explosive eruption of the volcano continues.',
      activityEn: 'ash plumes extended for 200 km to the eastern directions of the volcano',
      ashHeightM: null,
    });
    expect(ru).toBe('Продолжается умеренное эксплозивное извержение.');
  });

  it('незнакомая формула не переводится наугад', () => {
    expect(describeActivityRu({ hazardEn: 'Some entirely new wording from the source.', ashHeightM: null })).toBeNull();
    expect(describeActivityRu({ hazardEn: null, ashHeightM: null })).toBeNull();
  });

  it('дробная высота не округляется вверх', () => {
    const ru = describeActivityRu({
      hazardEn: 'Ash explosions up to 2.5 km (8,200 ft) a.s.l. could occur at any time.',
      ashHeightM: 2500,
    })!;
    expect(ru).toContain('до 2,5 км');
  });
});

describe('синк дополняет коды подробностями, а не переписывает их', () => {
  const SYNC = readFileSync(join(process.cwd(), 'lib/agents/kvert-sync.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('высота из блока VONA сильнее раздела активности', () => {
    expect(SYNC).toMatch(/const ashHeightM = v\.ashHeightM \?\? sec\?\.ashHeightM \?\? null/);
  });

  it('английский оригинал сохраняется как улика происхождения', () => {
    expect(SYNC).toMatch(/activityLevel: \(sec\?\.hazardEn \?\? v\.summary\)\?\.slice\(0, 200\)/);
  });

  it('сколько вулканов получили подробности — сообщается прогоном', () => {
    expect(SYNC).toMatch(/result\.detailed = details\.size/);
  });
});

describe('высота выброса отличается от расстояния (проба 06.09)', () => {
  it('Крашенинников: «danger of ash explosions up to 6 km a.s.l. remains»', () => {
    const s = by('krasheninnikov')!;
    expect(s.ashHeightM).toBe(6000);
    const ru = describeActivityRu({ hazardEn: s.hazardEn, activityEn: s.activityEn, ashHeightM: s.ashHeightM })!;
    expect(ru).toBe('Продолжается эффузивное извержение. Сохраняется опасность пепловых взрывов до 6 км над уровнем моря.');
  });

  it('«up to N km» БЕЗ пометки над уровнем моря высотой не считается', () => {
    // Лавовый поток и шлейф KVERT тоже меряет километрами. Прочитать их как
    // высоту значило бы объявить выброс в стратосферу.
    const flow = parseActivitySections(`
LAVA TEST VOLCANO (CAVW #300999)<br />
55.0 N, 160.0 E; Elevation 1000 m (3280 ft)<br />
Aviation Colour Code is  YELLOW<br />
The effusive eruption continues. Lava flows are moving up to 6 km to the eastern slope of the volcano.<br />
`)[0];
    expect(flow.ashHeightM).toBeNull();
  });

  it('незнакомая формула опасности оставляет высоту без фразы, а не сочиняет её', () => {
    const ru = describeActivityRu({
      hazardEn: 'The effusive eruption of the volcano continues. Ash up to 4 km a.s.l. was noted yesterday.',
      ashHeightM: 4000,
    });
    expect(ru).toBe('Продолжается эффузивное извержение.');
  });
});
