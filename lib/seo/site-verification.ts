import type { Metadata } from 'next';

/**
 * Подтверждение владения сайтом для вебмастеров — одно место на весь сайт.
 *
 * Google и Яндекс берут значения из переменных окружения Timeweb (так было с
 * самого начала). Bing — постоянным значением в коде: тег владелец получил в
 * Bing Webmaster Tools 15.10 («Add site → HTML Meta Tag») и прислал в чат.
 * Ключ Bing выдаёт на конкретный адрес сайта, а не на аккаунт: первый (15.10,
 * 4760…) был выписан на ошибочно добавленный адрес /api/mcp, и проверка
 * https://vedarai.ru/ ответила «Verification key incorrect» с этим ключом.
 * Значение публичное по природе — Bing читает его из HTML любой страницы, —
 * поэтому секретом не является и в переменную окружения не просится: лишняя
 * переменная на Timeweb была бы ещё одним местом, где тег можно потерять.
 *
 * Bing перепроверяет тег периодически: убрать его — потерять подтверждение
 * и отчёты вебмастера, поэтому layout собирает блок только отсюда (сторож —
 * tests/unit/site-verification.test.ts). Baidu (`baidu-site-verification`)
 * встанет сюда же, когда владелец пришлёт значение (docs/agents/CHINA.md, шаг 4).
 */
export const BING_SITE_VERIFICATION = 'AC1C1C2A5C527F87684D3E2571543A82';

/**
 * Китайские вебмастера — из переменных окружения, а не значением в коде
 * (находка CN-verify аудита 15.10). Причина в сроке: у Sogou и 360 код
 * подтверждения живёт 6 часов («请在6小时之内完成验证»), и PR, CI и выкат
 * в такое окно надёжно не укладываются; переменная на Timeweb требует только
 * перезапуска. Главная (`app/page.tsx`) — force-dynamic, поэтому значение,
 * прочитанное при старте сервера, попадает в её <head> без пересборки.
 *
 * Пустая или незаданная переменная — тега нет вовсе, а не пустой content.
 *
 * Имена тегов — из самих площадок, сверено 15.10:
 *  - Sogou: форма добавления сайта выдаёт `sogou_site_verification`
 *    (search.sogoucdn.com/zhanzhang/ssr/static/js/websiteAdd.ad67145d.js);
 *    статья справки пишет `sogou-site-verification` — проверяют по форме;
 *  - Toutiao: `bytedance-verification-code` — форма вебмастера
 *    (search_webmaster_client/static/js/main.38d268c6.js);
 *  - 360: `360-site-verification` — справка www.so.com/help/help_3_8.html
 *    («Head中未找到对应的meta值，name=360-site-verification»);
 *  - Shenma: `shenma-site-verification` — по вторичным источникам 15.10, НЕ
 *    сверено с формой: код выдаётся только после входа, а справка
 *    zhanzhang.sm.cn/open/helpuser имени тега не называет.
 *
 * Поэтому переменная принимает и голый код, и тег целиком, как его показывает
 * форма: из вставленного `<meta name="…" content="…">` берётся content, а
 * имя — то, что выдала форма, если это имя тега подтверждения. Так неверная
 * догадка об имени (Shenma) не стоит нового кода и нового окна проверки.
 */
export const CHINA_VERIFICATION_SLOTS = [
  { env: 'SHENMA_SITE_VERIFICATION', name: 'shenma-site-verification' },
  { env: 'SOGOU_SITE_VERIFICATION', name: 'sogou_site_verification' },
  { env: 'TOUTIAO_SITE_VERIFICATION', name: 'bytedance-verification-code' },
  { env: 'SO360_SITE_VERIFICATION', name: '360-site-verification' },
] as const;

/**
 * Имя из вставленного тега принимается, только если это имя тега
 * подтверждения: слот не должен стать дверью для `robots` или `referrer`
 * из переменной окружения.
 */
const VERIFICATION_TAG_NAME = /^[a-z0-9][a-z0-9_.-]*verif[a-z0-9_.-]*$/i;

function tagAttr(tag: string, key: string): string | undefined {
  const m = new RegExp(`\\s${key}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag);
  const v = m?.[2]?.trim();
  return v ? v : undefined;
}

export interface VerificationTag {
  name: string;
  content: string;
}

/**
 * Тег одного слота. `null` — тега нет: переменная пуста, либо в неё вставлен
 * тег без content. Второй случай — отказ, а не «не задано»: он называется в
 * логе по имени переменной (§4.0), само значение не печатается.
 */
export function verificationTagFromEnv(
  raw: string | undefined,
  slot: { env: string; name: string },
): VerificationTag | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!value.startsWith('<')) return { name: slot.name, content: value };

  const content = tagAttr(value, 'content');
  if (!content) {
    console.warn(`[site-verification] ${slot.env}: вставлен тег без content — тег подтверждения не выводится`);
    return null;
  }
  const pastedName = tagAttr(value, 'name');
  const name = pastedName && VERIFICATION_TAG_NAME.test(pastedName) ? pastedName : slot.name;
  return { name, content };
}

export function siteVerification(env: NodeJS.ProcessEnv = process.env): NonNullable<Metadata['verification']> {
  const other: Record<string, string> = {
    'msvalidate.01': BING_SITE_VERIFICATION,
  };
  for (const slot of CHINA_VERIFICATION_SLOTS) {
    const tag = verificationTagFromEnv(env[slot.env], slot);
    if (tag) other[tag.name] = tag.content;
  }
  return {
    google: env.GOOGLE_SITE_VERIFICATION,
    yandex: env.YANDEX_VERIFICATION,
    other,
  };
}
