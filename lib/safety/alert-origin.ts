/**
 * Откуда пришла тревога — по её `external_id`, а не по константе.
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * `lib/safety/current-status.ts` подписывал ЛЮБОЙ ответ строкой
 * `source: 'КБГС РАН'`. При этом `external_alerts` кормят как минимум пять
 * лент: КБГС РАН и ЕГС РАН (сейсмика, Telegram), USGS (сейсмика), МЧС по
 * Камчатскому краю (RSS, VK, MAX — паводки, погода, вулканы, дороги,
 * медведи), NASA FIRMS (пожары), новости правительства края, и ещё ручные
 * записи администратора. Найдено 16.09 сверкой пакета для каталогов MCP:
 * верхней тревогой в тот момент был паводок в Соболевском округе —
 * сообщение МЧС, — и инструмент `safety_status` подписал его «Источник:
 * КБГС РАН». Ярлык без производителя (§4.0, §10.09): сейсмологи не
 * предупреждают о паводках.
 *
 * ── Правило ───────────────────────────────────────────────────────────────
 *
 * Происхождение выводится из `external_id`, который каждая лента пишет по
 * своей форме (`t.me/kbgsras/6680`, `usgs/…`, `firms/…`, `mchs/…`,
 * `vk.com/mchs_kamchatka/…`, `max/…`, `kamgov/…`, `visitkamchatka/…`,
 * `manual-…`). Формы собраны из кода лент (`lib/services/safety/
 * seismic-parser.ts`, `wildfire-firms.ts`, `app/api/admin/external-alerts`),
 * и сторож `tests/unit/alert-origin.test.ts` требует, чтобы каждая из них
 * узнавалась. Префиксы новостных лент он читает из `NEWS_FEED_PREFIXES`
 * самого классификатора: ручная перепись 17.09 пропустила `visitkamchatka`,
 * и 18.09 тревога с него ушла агентам как «источник не записан».
 *
 * Неузнанная форма — `null`, и текст говорит «источник не записан».
 * Подставлять ближайший правдоподобный нельзя: это и была прежняя ошибка.
 */

export interface AlertOrigin {
  /** Короткий ключ ленты — совпадает с `source_key` в source-health, где есть. */
  key: string;
  /** Как назвать человеку. */
  label: string;
}

interface OriginRule {
  test: (externalId: string, sourceUrl: string) => boolean;
  origin: AlertOrigin | ((externalId: string) => AlertOrigin);
}

const MCHS = 'МЧС России по Камчатскому краю';

const RULES: readonly OriginRule[] = [
  { test: (id) => id.startsWith('t.me/kbgsras/'),  origin: { key: 'kbgsras',  label: 'КБГС РАН' } },
  { test: (id) => id.startsWith('t.me/eqkam/'),    origin: { key: 'eqkam',    label: 'КФ ФИЦ ЕГС РАН (EQKam)' } },
  // Таблица землетрясений с главной emsd.ru (24.09). Ключ совпадает с
  // source_key в source-health, как требует шапка интерфейса.
  { test: (id) => id.startsWith('www.emsd.ru/eq/'), origin: { key: 'emsd_quakes', label: 'КФ ФИЦ ЕГС РАН (emsd.ru)' } },
  { test: (id) => id.startsWith('usgs/'),          origin: { key: 'usgs',     label: 'USGS' } },
  { test: (id) => id.startsWith('firms/'),         origin: { key: 'firms',    label: 'NASA FIRMS' } },
  { test: (id) => id.startsWith('mchs/'),          origin: { key: 'mchs_rss', label: MCHS } },
  // VK: в базу уходит id события `vk_mchs/<день>/t…` (VK_MCHS_PREFIX), а не
  // id поста — 25.09 все тревоги МЧС из VK подписывались «источник не записан».
  // Прежняя форма оставлена для старых строк.
  { test: (id) => id.startsWith('vk_mchs/') || id.startsWith('vk.com/mchs_kamchatka/'), origin: { key: 'vk_mchs', label: `${MCHS} (VK)` } },
  {
    test: (id, url) => id.startsWith('max_mchs/') || id.startsWith('max/') || /^https?:\/\/max\.ru\//.test(url),
    origin: { key: 'max_mchs', label: `${MCHS} (MAX)` },
  },
  { test: (id) => id.startsWith('kamgov/'),        origin: { key: 'kamgov',   label: 'Правительство Камчатского края' } },
  // Турпортал края (NEWS_FEED_SOURCES, optional). Пропущен переписью 17.09:
  // 18.09 верхняя тревога «пепловый выброс Шивелуча» шла с него и получала
  // «источник не записан». Теперь префиксы читает из кода сам сторож.
  { test: (id) => id.startsWith('visitkamchatka/'), origin: { key: 'visitkamchatka', label: 'Турпортал Камчатского края (visitkamchatka.ru)' } },
  { test: (id) => id.startsWith('manual-'),        origin: { key: 'manual',   label: 'ручная запись администратора Ведара' } },
  // Любой другой Telegram-канал: имя канала — факт из id, не догадка.
  {
    test: (id) => /^t\.me\/[^/]+\//.test(id),
    origin: (id) => ({ key: 'telegram', label: `Telegram-канал @${id.split('/')[1]}` }),
  },
];

export function alertOrigin(externalId: string | null | undefined, sourceUrl?: string | null): AlertOrigin | null {
  const id = (externalId ?? '').trim();
  const url = (sourceUrl ?? '').trim();
  if (!id && !url) return null;
  for (const rule of RULES) {
    if (rule.test(id, url)) {
      return typeof rule.origin === 'function' ? rule.origin(id) : rule.origin;
    }
  }
  return null;
}

/** Строка для человека, когда происхождение не узнано. Одна на все случаи. */
export const UNKNOWN_ORIGIN_TEXT = 'источник не записан';

/**
 * Автоматические ленты, из которых складывается обстановка по краю, — для
 * ответа «по краю целиком», где верхняя тревога одна, а лент много.
 * Ручные записи и безымянные Telegram-каналы сюда не входят: это не ленты.
 */
export const SAFETY_FEEDS: readonly string[] = [
  'КБГС РАН и КФ ФИЦ ЕГС РАН (сейсмика)',
  'USGS (сейсмика)',
  `${MCHS} (RSS, VK, MAX)`,
  'NASA FIRMS (пожары)',
  'Правительство Камчатского края (новости)',
  'Турпортал Камчатского края visitkamchatka.ru (новости о безопасности)',
];
