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

export function siteVerification(env: NodeJS.ProcessEnv = process.env): NonNullable<Metadata['verification']> {
  return {
    google: env.GOOGLE_SITE_VERIFICATION,
    yandex: env.YANDEX_VERIFICATION,
    other: {
      'msvalidate.01': BING_SITE_VERIFICATION,
    },
  };
}
