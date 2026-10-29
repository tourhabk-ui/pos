/**
 * GET /api/cron/source-probe — достижимы ли кандидаты в источники С ПРОДА.
 * Authorization: Bearer <CRON_SECRET>. READ-ONLY, ничего не пишет.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Подбор источников идёт с раннера GitHub, а он стоит ВНЕ РФ. Государственные
 * сайты часть зарубежных адресов не пускают, и на уровне сокета их отказ
 * неотличим от мёртвого хоста: `publication.pravo.gov.ru` — единственный
 * настоящий первоисточник права в подборе — дал с раннера сетевой сбой, и
 * сказать по нему «ленты нет» было бы подменой «не смог» на «плохо» (§4.0).
 *
 * Прод стоит в РФ. Для таких адресов он — вторая точка зрения, и только он
 * может отличить «нас туда не пускают» от «этого адреса не существует».
 *
 * ── Почему список зашит в код ──────────────────────────────────────────────
 *
 * Роут, который ходит по адресу ИЗ ПАРАМЕТРА, — это SSRF: сервер начинает
 * стучаться куда попросят, включая внутреннюю сеть Timeweb и служебные
 * адреса. Поэтому адреса перечислены здесь поимённо, а параметров у роута
 * нет вовсе. Нужен новый кандидат — он вносится правкой кода и проходит
 * ревью, как всякая правка.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Кандидаты, которых раннер проверить не смог. Список короткий намеренно:
 * это не «спросить интернет», а доспросить конкретные адреса из подбора.
 */
const CANDIDATES: ReadonlyArray<{ url: string; why: string }> = [
  { url: 'https://publication.pravo.gov.ru/', why: 'официальный портал правовой информации — корень, жив ли хост' },
  { url: 'https://publication.pravo.gov.ru/rss', why: 'предполагаемая лента портала: единственный первоисточник права в подборе' },
  { url: 'https://www.kscnet.ru/ivs/kvert/van/rss.php', why: 'KVERT — вулканические бюллетени (VONA у нас уже есть, лента была бы вторым путём)' },
  // 08.09: единственная лента домена «конкуренты» в intelligence_sources
  // отдаёт HTML вместо ленты (HTTP 200, 9 КБ) — то есть домен не пуст, а
  // мёртв. Прежде чем гасить строку или менять адрес, надо знать, есть ли у
  // издания рабочая лента вообще; спрашивать об этом надо с прода — из
  // песочницы агента aif.ru закрыт прокси, и её отказ про сайт не говорит
  // ничего. Три обычных для рунета адреса, а не поиск наугад.
  { url: 'https://kamchatka.aif.ru/rss/all.php', why: 'АиФ-Камчатка — обычный адрес ленты изданий АиФ' },
  { url: 'https://kamchatka.aif.ru/rss.php', why: 'АиФ-Камчатка — второй обычный адрес ленты' },
  { url: 'https://kamchatka.aif.ru/feed', why: 'АиФ-Камчатка — адрес ленты в движках общего вида' },
  // 29.10, карт-бланш владельца на бесплатные API: разведка (workflow
  // free-api-recon-kamchatka) не дошла ни до одного хоста из песочницы, а
  // раннер стоит вне РФ. Брать ли источник, решает ответ ОТСЮДА.
  { url: 'https://aviationweather.gov/api/data/metar?ids=UHPP&format=json&hours=3', why: 'METAR аэродрома Елизово (NOAA AWC): наблюдение погоды в аэропорту к табло /flights' },
  { url: 'https://aviationweather.gov/api/data/taf?ids=UHPP&format=json', why: 'TAF аэродрома Елизово (NOAA AWC): прогноз аэродрома' },
  { url: 'https://www.tsunami.gov/events/xml/PHEBAtom.xml', why: 'PTWC — лента сообщений тихоокеанского центра (только дополнение к официальной тревоге, не замена)' },
  { url: 'https://www.tsunami.gov/events/xml/PHEBCAP.xml', why: 'PTWC — последнее сообщение в CAP' },
  { url: 'https://www.tsunami.gov/events/json/PHEBWEPA40.json', why: 'PTWC — слот угрозы для Тихого океана в JSON (недокументированный, сверка с Atom)' },
  { url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json', why: 'NOAA SWPC — прогноз Kp на 3 дня (северное сияние)' },
  { url: 'https://services.swpc.noaa.gov/text/3-day-forecast.txt', why: 'NOAA SWPC — текстовый прогноз на 3 дня' },
  { url: 'https://www.cbr.ru/scripts/XML_daily.asp', why: 'Банк России — официальные курсы на сегодня (≈ ¥ у цены на китайских страницах)' },
  { url: 'https://api.inaturalist.org/v1/observations?taxon_name=Ursus%20arctos&quality_grade=research&swlat=50&swlng=155&nelat=65.5&nelng=174&per_page=1', why: 'iNaturalist — наблюдения бурого медведя в рамке края (доступ и объём; лицензия — отдельный вопрос)' },
  { url: 'https://api.gbif.org/v1/occurrence/search?decimalLatitude=50,65.5&decimalLongitude=155,174&hasCoordinate=true&limit=0&facet=license', why: 'GBIF — записи в рамке края по лицензиям (доля CC0/CC BY)' },
  { url: 'https://query.wikidata.org/sparql?format=json&query=SELECT%20%3Fru%20WHERE%20%7B%20wd%3AQ7948%20rdfs%3Alabel%20%3Fru%20.%20FILTER(LANG(%3Fru)%20%3D%20%22ru%22)%20%7D', why: 'Wikidata — запрос о Камчатском крае (доступ к SPARQL)' },
  { url: 'https://api.opentopodata.org/v1/srtm30m?locations=53.255,158.83|53.04,158.65', why: 'Open Topo Data — высоты Авачинского и Петропавловска (уже в проде, сверка набора в ответе)' },
];

/**
 * Два обличья запроса.
 *
 * 08.09: publication.pravo.gov.ru не ответил ни раннеру (вне РФ), ни проду
 * (в РФ) — причём не ответил даже КОРЕНЬ сайта, не только предполагаемая
 * лента. Это сняло версию про гео-блок: раз обе точки зрения дают одно и то
 * же, дело не в том, откуда мы смотрим.
 *
 * Осталась вторая правдоподобная причина, и её надо не предполагать, а
 * замерить: государственные порталы часто закрываются от машинных клиентов —
 * по User-Agent, по отсутствию Accept-Language, по «слишком голому» набору
 * заголовков. Поэтому каждый адрес спрашивается ДВАЖДЫ, и ответ становится
 * различающим:
 *
 *   оба обличья молчат            — адрес недостижим отсюда вообще;
 *   бот молчит, браузер отвечает  — нас отсекают по виду клиента;
 *   оба отвечают                  — адрес живой, вопрос закрыт.
 *
 * Браузерное обличье — это НЕ обход защиты: мы не подделываем сессию, не
 * обходим капчу и не притворяемся человеком в интерфейсе. Мы читаем публичную
 * страницу и называем в заголовках то, что назвал бы обычный читатель.
 * Значения строго ASCII: кириллица в заголовке ломает undici.
 */
const PERSONAS = {
  bot: {
    'User-Agent': 'TourHab/1.0 (source probe)',
  },
  browser: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  },
} as const;

type Persona = keyof typeof PERSONAS;

interface Attempt {
  /** Что ответил сервер: код, либо null — не дошли вовсе. */
  status: number | null;
  content_type: string | null;
  bytes: number | null;
  /** Похоже ли тело на ленту: xml/rss/atom в типе или корневой тег. */
  looks_like_feed: boolean | null;
  /** Название беды словами, когда ответа нет. */
  error: string | null;
  /**
   * Начало тела (29.10): «200» ещё не значит «данные». У API без ключа отказ
   * часто приходит кодом 200 с телом ошибки, а лента бывает пустой; судить
   * можно только по содержимому.
   */
  head: string | null;
  /** Сколько шёл ответ, мс. */
  ms: number | null;
  /** Last-Modified: у лент вроде PTWC это единственный признак живого канала. */
  last_modified: string | null;
}

interface ProbeResult {
  url: string;
  why: string;
  /** Ответ на запрос нашим агентом и браузерным — по отдельности. */
  attempts: Record<Persona, Attempt>;
  /** Вывод из пары попыток, словами: он и есть смысл двойного запроса. */
  /**
   * Вердикт достижимости. `открыт, но не лента` заведён 08.09 по замеру 40:
   * все три адреса АиФ-Камчатка ответили 200 и одинаковой HTML-страницей на
   * ~9.5 КБ. Формально «открыт» — и это верно про ХОСТ, но читалось как ответ
   * на другой вопрос: «лента есть». Настоящий ответ лежал в `looks_like_feed`,
   * то есть в поле, которое надо было догадаться прочитать вторым.
   *
   * Вопрос «жив ли адрес» и вопрос «отдаёт ли он ленту» — разные, и для
   * кандидата в источники решает второй. Слово вердикта обязано отвечать на
   * тот вопрос, ради которого адрес и спрашивали.
   */
  verdict: 'открыт' | 'открыт, но не лента' | 'отсекают по виду клиента' | 'недостижим' | 'ответил только боту';
}

async function attempt(url: string, persona: Persona): Promise<Attempt> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: PERSONAS[persona],
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    const body = await res.text();
    const ct = res.headers.get('content-type');
    const head = body.slice(0, 400).toLowerCase();
    return {
      status: res.status,
      content_type: ct,
      bytes: body.length,
      looks_like_feed:
        (ct ?? '').toLowerCase().includes('xml')
        || head.includes('<rss') || head.includes('<feed') || head.includes('<rdf'),
      error: null,
      head: body.slice(0, 240).replace(/\s+/g, ' '),
      ms: Date.now() - started,
      last_modified: res.headers.get('last-modified'),
    };
  } catch (err) {
    // Отказ называется вслух: молчащая проба неотличима от пройденной.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[source-probe] ${url} (${persona}): ${message}`);
    return { status: null, content_type: null, bytes: null, looks_like_feed: null, error: message.slice(0, 160), head: null, ms: Date.now() - started, last_modified: null };
  }
}

/** Ответил ли сервер хоть что-то осмысленное. 4xx/5xx ответом не считаем. */
function answered(a: Attempt): boolean {
  return a.status !== null && a.status < 400;
}

async function probe(c: { url: string; why: string }): Promise<ProbeResult> {
  const bot = await attempt(c.url, 'bot');
  const browser = await attempt(c.url, 'browser');

  const verdict: ProbeResult['verdict'] =
    answered(browser) && answered(bot)
      ? (
        // Хост ответил обоим — но лентой ли? `looks_like_feed === false` это
        // измеренное «нет», а `null` — «не смотрели»; второе в вердикт не
        // превращаем, иначе «не знаю» уедет как «не лента» (§4.0).
        browser.looks_like_feed === false && bot.looks_like_feed === false
          ? 'открыт, но не лента'
          : 'открыт'
      )
    : answered(browser) ? 'отсекают по виду клиента'
    : answered(bot) ? 'ответил только боту'
    : 'недостижим';

  return { url: c.url, why: c.why, attempts: { bot, browser }, verdict };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = await Promise.all(CANDIDATES.map(probe));

  return NextResponse.json({
    ok: true,
    probe: 'source_probe_v1',
    measured_at: new Date().toISOString(),
    vantage: 'prod',
    // Смысл замера — в сравнении с раннером, поэтому он назван прямо в ответе:
    // одно и то же «не ответил» с двух точек значит разное.
    note: 'Прод стоит в РФ, раннер — вне. Ответ отсюда при отказе раннеру означает гео-блок; отказ с обеих точек снимает эту версию. Каждый адрес спрашивается двумя обличьями: наш агент и браузерный — «отсекают по виду клиента» и «недостижим» это разные беды с разной починкой.',
    results,
  });
}
