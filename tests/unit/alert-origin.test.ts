/**
 * Сторож: источник тревоги — из данных, не из константы.
 *
 * ── Как нашлось ────────────────────────────────────────────────────────────
 *
 * 16.09, сверка пакета для каталогов MCP. Инструмент `safety_status`
 * живьём: верхняя тревога — «спасатели выдвинулись в Соболевский округ,
 * непростая гидрологическая обстановка (flood)», подпись — «Источник: КБГС
 * РАН». Сейсмологи о паводках не предупреждают; сообщение было от МЧС.
 * `lib/safety/current-status.ts` держал `SAFETY_SOURCE = 'КБГС РАН'`
 * константой на любой ответ, а таблицу кормят пять лент.
 *
 * Ярлык без производителя (§4.0, §10.09): подпись читает человек, который
 * по ней решает, кому верить.
 *
 * ── Что держится ───────────────────────────────────────────────────────────
 *
 * Каждая форма `external_id`, которую пишут ленты, узнаётся; неузнанная
 * отдаёт null, а не ближайшее правдоподобное; статус спрашивает у верхней
 * тревоги её id, а константы больше нет ни в статусе, ни в плитке главной.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alertOrigin, SAFETY_FEEDS, UNKNOWN_ORIGIN_TEXT } from '@/lib/safety/alert-origin';
import { formatSafetyStatusForAgent, SAFETY_FEEDS_TEXT } from '@/lib/safety/current-status';
import { NEWS_FEED_PREFIXES, VK_MCHS_PREFIX, MAX_MCHS_PREFIX, MCHS_FEED_PREFIX } from '@/lib/services/safety/seismic-parser';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/**
 * Формы id — из кода лент, не из головы:
 *   seismic-parser: `t.me/${channel}/${msgId}`, `usgs/${f.id}`,
 *     `${sourcePrefix}/${day}/t${fingerprint}` (mchs, kamgov),
 *     `vk.com/${VK_MCHS_DOMAIN}/${post.id}`, `max/${fingerprint}`;
 *   wildfire-firms: `firms/${date}/${lat},${lng}`;
 *   admin/external-alerts: `manual-${slug}`.
 */
const PRODUCED: Array<[string, string | null, string]> = [
  ['t.me/kbgsras/6680', null, 'КБГС РАН'],
  ['t.me/eqkam/1234', null, 'КФ ФИЦ ЕГС РАН (EQKam)'],
  ['usgs/us7000abcd', 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd', 'USGS'],
  ['firms/2026-09-16/56.1,160.2', 'https://firms.modaps.eosdis.nasa.gov/map/', 'NASA FIRMS'],
  ['mchs/2026-09-16/tabc123', 'https://41.mchs.gov.ru/deyatelnost/press-centr/novosti/1', 'МЧС России по Камчатскому краю'],
  ['vk.com/mchs_kamchatka/77', 'https://vk.com/wall-1_77', 'МЧС России по Камчатскому краю (VK)'],
  ['max/tdeadbeef', 'https://max.ru/id4101120929_gos', 'МЧС России по Камчатскому краю (MAX)'],
  ['kamgov/2026-09-16/t0102', 'https://kamgov.ru/news/1', 'Правительство Камчатского края'],
  /**
   * 18.09: владелец сверил прод — верхняя тревога «пепловый выброс Шивелуча»
   * с турпортала, инструмент подписал её «источник не записан». Лента
   * `visitkamchatka` стояла в NEWS_FEED_SOURCES с самого начала, а в этом
   * списке — нет: перепись форм id делалась руками и повторила пропуск.
   */
  ['visitkamchatka/2026-09-18/tabcd', 'https://visitkamchatka.ru/security/1', 'Турпортал Камчатского края (visitkamchatka.ru)'],
  ['manual-shiveluch-ash', null, 'ручная запись администратора Ведара'],
  ['t.me/minec_tourism/42', null, 'Telegram-канал @minec_tourism'],
];

describe('происхождение тревоги узнаётся по форме id каждой ленты', () => {
  for (const [id, url, label] of PRODUCED) {
    it(`${id} → ${label}`, () => {
      expect(alertOrigin(id, url)?.label).toBe(label);
    });
  }

  it('соцканалы МЧС узнаются по той форме id, что реально уходит в базу (25.09)', () => {
    // Сверка MCP 25.09: паводок у Соболево из VK шёл «источник не записан».
    // В базу пишется id события `${prefix}/<день>/t…`, а не id поста, — и
    // префиксы читаются из кода ленты, а не из этого файла. Адрес пустой:
    // узнавание обязано идти по id, спасение по адресу (max.ru) — случайность.
    for (const prefix of [MCHS_FEED_PREFIX, VK_MCHS_PREFIX, MAX_MCHS_PREFIX]) {
      const o = alertOrigin(`${prefix}/2026-09-25/tabcd`, null);
      expect(o, `${prefix}: лента МЧС пишет тревоги, а правило её не узнаёт`).not.toBeNull();
      expect(o!.label).toMatch(/^МЧС России по Камчатскому краю/);
    }
    expect(alertOrigin(`${VK_MCHS_PREFIX}/2026-09-25/tabcd`, null)!.label).toContain('(VK)');
    expect(alertOrigin(`${MAX_MCHS_PREFIX}/2026-09-25/tabcd`, null)!.label).toContain('(MAX)');
  });

  it('префиксы соцканалов не зашиты строками в вызовах — только константами', () => {
    const parser = read('lib/services/safety/seismic-parser.ts');
    expect(parser).not.toMatch(/classifyMchsItems\([^)]*'(vk_mchs|max_mchs)'\)/);
  });

  it('каждый префикс новостных лент из кода классификатора узнаётся — перепись не ручная', () => {
    /**
     * Список PRODUCED выше набран руками и один раз уже пропустил ленту.
     * Здесь префиксы читаются из seismic-parser: новая лента без правила
     * происхождения краснеет сама, а не после чужого замера прода.
     */
    expect(NEWS_FEED_PREFIXES.length).toBeGreaterThanOrEqual(3);
    for (const prefix of NEWS_FEED_PREFIXES) {
      const o = alertOrigin(`${prefix}/2026-09-18/tabcd`, null);
      expect(o, `${prefix}: лента пишет тревоги, а правила происхождения для неё нет`).not.toBeNull();
      expect(o!.label.length).toBeGreaterThan(3);
    }
  });

  it('паводок от МЧС больше не подписывается сейсмологами', () => {
    // Случай 16.09 дословно: id по форме RSS МЧС.
    const o = alertOrigin('mchs/2026-09-16/t5c1e', 'https://41.mchs.gov.ru/');
    expect(o?.label).not.toMatch(/КБГС/);
    expect(o?.label).toMatch(/МЧС/);
  });

  it('неузнанная форма — null, а не ближайшее правдоподобное', () => {
    expect(alertOrigin('something/else', null)).toBeNull();
    expect(alertOrigin('', '')).toBeNull();
    expect(alertOrigin(null, null)).toBeNull();
    expect(alertOrigin(null, 'https://example.org/x')).toBeNull();
  });

  it('MAX узнаётся и по адресу, когда id пришёл от раннера в своей форме', () => {
    expect(alertOrigin('9876543', 'https://max.ru/id4101120929_gos')?.key).toBe('max_mchs');
  });
});

describe('статус берёт источник у верхней тревоги', () => {
  const STATUS = read('lib/safety/current-status.ts');

  it('константы SAFETY_SOURCE больше нет — ни здесь, ни у потребителей', () => {
    expect(STATUS).not.toMatch(/SAFETY_SOURCE\b/);
    expect(read('app/api/public/safety-status/route.ts')).not.toMatch(/SAFETY_SOURCE\b/);
    // Четыре места подставляли «КБГС РАН» сами: плитка главной, карточка тура,
    // серверный статус главной. Своего умолчания ни у кого больше нет.
    for (const f of [
      'components/homepage/HeroStatus.tsx',
      'app/marketplace/tours/[id]/_TourDetailClient.tsx',
      'app/page.tsx',
    ]) {
      expect(read(f), `${f}: своё умолчание источника`).not.toMatch(/['"]КБГС РАН['"]/);
    }
  });

  it('главная не держит второй копии запроса обстановки', () => {
    // До 17.09 app/page.tsx повторял SQL из current-status.ts дословно и
    // подписывал результат константой. Одно правило — один запрос.
    const page = read('app/page.tsx');
    expect(page).toMatch(/getCurrentSafetyStatus\(/);
    expect(page).not.toMatch(/SELECT title FROM external_alerts/);
  });

  it('SQL верхней тревоги отдаёт external_id и source_url — по ним и узнаётся происхождение', () => {
    expect(STATUS).toMatch(/SELECT title, alert_type, external_id, source_url\s*\n\s*FROM external_alerts/);
    expect(STATUS).toMatch(/alertOrigin\(top\.external_id, top\.source_url\)/);
    expect(STATUS).toMatch(/UNKNOWN_ORIGIN_TEXT/);
  });

  it('описание инструмента не называет единственный источник', () => {
    const schema = read('lib/kuzmich/tool-schemas.ts');
    const desc = schema.slice(schema.indexOf("name: 'safety_status'"), schema.indexOf("name: 'safety_status'") + 700);
    expect(desc).not.toMatch(/источник — КБГС РАН/);
    expect(desc).toMatch(/МЧС/);
    expect(desc).toMatch(/FIRMS/);
  });

  it('текст агенту: источник принадлежит названному предупреждению', () => {
    const text = formatSafetyStatusForAgent({
      hasAlert: true, maxSeverity: 2, activeCount: 21,
      topTitle: 'Спасатели выдвинулись в Соболевский округ', topType: 'flood',
      dataUpdatedAt: '2026-09-17T01:11:33Z', source: 'МЧС России по Камчатскому краю',
    });
    expect(text).toMatch(/Источник этого предупреждения: МЧС России по Камчатскому краю\./);
    expect(text).not.toMatch(/КБГС/);
  });

  it('тревог нет — перечислены ленты, а не одна из них', () => {
    const text = formatSafetyStatusForAgent({
      hasAlert: false, maxSeverity: 0, activeCount: 0,
      topTitle: null, topType: null, dataUpdatedAt: null, source: SAFETY_FEEDS_TEXT,
    });
    expect(text).toMatch(/Ленты, по которым собирается обстановка:/);
    for (const feed of SAFETY_FEEDS) expect(text).toContain(feed);
  });

  it('происхождение не узнано — так и сказано', () => {
    expect(UNKNOWN_ORIGIN_TEXT).toBe('источник не записан');
    const text = formatSafetyStatusForAgent({
      hasAlert: true, maxSeverity: 1, activeCount: 1,
      topTitle: 'Что-то', topType: 'info', dataUpdatedAt: null, source: UNKNOWN_ORIGIN_TEXT,
    });
    expect(text).toMatch(/Источник этого предупреждения: источник не записан\./);
  });
});
