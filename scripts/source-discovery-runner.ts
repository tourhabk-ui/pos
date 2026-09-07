/**
 * scripts/source-discovery-runner.ts — поиск источников разведчика одним
 * проходом, с раннера.
 *
 * ── Повод ──────────────────────────────────────────────────────────────────
 *
 * Владелец 07.09, вопрос по составу разведки: «все источники и туриндустрия с
 * законодательством рф? и опасности». Замер по коду: из 16 живых источников
 * четыре туристических — все отраслевые пересказы (Турпром, RATA, РСТ,
 * Минэк-ТГ), правового источника нет ни одного; опасности приходят живьём
 * (землетрясения, цунами, вулканы, пожары, паводок, дороги, погода), а
 * лавинных наблюдений нет вовсе — тип `avalanche` объявлен, текст пуша для
 * него написан, и НИ ОДИН источник его никогда не пишет.
 *
 * ── Почему модель, а не список руками ──────────────────────────────────────
 *
 * Владелец: «используй астру, она может собрать все одним проходом, у неё
 * огромный объём». Так и есть: у Astra контекст на миллион, и она держит
 * разом весь текущий состав, кладбище мёртвых лент и обе цели. Перечислять
 * ведомства по памяти — работа, в которой человек и я одинаково слабы.
 *
 * ── Почему находке нельзя верить на слово ──────────────────────────────────
 *
 * Адрес — это ровно тот вид факта, который модель выдумывает охотнее всего:
 * `https://<ведомство>.gov.ru/rss` выглядит правдоподобно всегда. В этом
 * репозитории уже записано, чем кончается доверие к правдоподобному: у МЧС и
 * kamgov ленты СНЯТЫ (404), и «гадать новый URL нечего» стоит прямым текстом
 * в scout-digest.
 *
 * Поэтому здесь два разных этапа, и они не смешиваются:
 *
 *   1. модель ПРЕДЛАГАЕТ — широко, это её сильная сторона;
 *   2. пригодность решает ПЕРЕПИСЬ — запрос по каждому адресу, статус, размер
 *      и тип содержимого. Ни один адрес не попадает в RSS_SOURCES из ответа
 *      модели: только из ответа сервера.
 *
 * Приём тот же, что у `finding-guard` для Growth Scan и у разбора справочника
 * маршрутов: выдумки не спорятся, а считаются числом и печатаются.
 *
 * ── Чего этот разбор НЕ делает ─────────────────────────────────────────────
 *
 * Ничего не пишет ни в базу, ни в состав источников. Печатает таблицу с
 * приговором по каждому адресу; вносит человек.
 *
 * И отдельно: отказ адреса С РАННЕРА не значит «ленты нет». Раннер стоит вне
 * РФ, а часть государственных сайтов закрывает зарубежные адреса — ровно
 * зеркало нашей же беды с t.me, который закрыт с прода. Такой исход называется
 * `refused_here`, а не `dead`, и требует второй проверки с прода.
 *
 * Использование: npx tsx scripts/source-discovery-runner.ts [модель]
 */
import { openRouterAttribution } from '../lib/ai/attribution';

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-6-astra';
const RUB_PER_USD = 135; // §8

/** Что уже стоит в разведке — чтобы модель не предлагала то же самое. */
const CURRENT_SOURCES = [
  'Simon Willison (ai, rss)', 'Hugging Face (ai, rss)', 'MarkTechPost (ai, rss)',
  'Hacker News (ai, rss)', 'Habr AI (ai, rss)', 'OpenAI (ai, rss)',
  'Google AI (ai, rss)', 'DeepMind (ai, rss)', 'Vibecoding (ai, telegram)',
  'Skift (reference, rss)', 'Product Hunt (reference, rss)',
  'Турпром (travel, rss)', 'RATA News (travel, rss)',
  'РСТ (travel, telegram)', 'Минэк — туризм (travel, telegram)',
  'Safety-слой (kamchatka, своя база external_alerts)',
];

/**
 * Кладбище: ленты, которые МЫ уже проверяли и они мертвы. Без этого блока
 * модель предложит ровно их — они самые известные и самые правдоподобные.
 */
const GRAVEYARD = [
  '41.mchs.gov.ru/rss — HTTP 404, гос-CMS ушла с RSS (проверено 01.08)',
  'kamgov.ru/rss — HTTP 404 как лента разведчика; XML жив, но НЕ открывается с прода (Timeweb), только с раннера',
  'atorus.ru/rss/news.xml — HTTP 404 (проверено 01.08)',
  'rata-news.ru — хост не отвечал (проверено 01.08), заменён на ratanews.ru',
  'rostourunion.ru — лент нет вовсе: /rss/, /rss.xml, /news/rss/, /feed/ дают 404 (перепись 03.09)',
];

const SYSTEM = `Ты подбираешь ИСТОЧНИКИ НОВОСТЕЙ для разведчика туристической платформы Камчатки.

Платформа отвечает за безопасность туристов в дикой природе и работает с российскими туроператорами.

Читать мы умеем ровно два вида источников:
1. RSS или Atom — обычная лента, отдающая XML;
2. публичное превью Telegram-канала в форме https://t.me/s/<канал> (ссылки-приглашения t.me/+... читать нельзя по построению).

HTML-страницы, требующие разбора вёрстки, API с ключами и закрытые каналы — не предлагай.

ТЕБЕ НУЖНЫ ДВЕ ОБЛАСТИ:

area="law" — законодательство и регулирование туризма в РФ: тексты и проекты нормативных актов, официальные публикации, реестры туроператоров, требования к перевозке и размещению, надзор. Нам важен первоисточник, а не пересказ отраслевой ленты — пересказы у нас уже есть.

area="hazard" — наблюдаемые опасности Камчатки и Дальнего Востока: лавинная опасность, штормовые предупреждения, гидрометеорология, сейсмика, вулканическая активность, паводки, пожары. Особо нужна ЛАВИННАЯ опасность: у нас нет ни одного источника лавинных наблюдений.

ЧЕСТНОСТЬ ВАЖНЕЕ ПОЛНОТЫ. Не выдумывай адреса. Если ты не уверен, что лента существует по этому точному адресу, всё равно предложи её, но поставь confidence="guess" — её проверят запросом. Выдуманный адрес с confidence="known" хуже пропущенного источника: он тратит проверку и подрывает доверие ко всему списку.

Ответ — СТРОГО JSON, без пояснений вокруг:
{"candidates":[{"name":"...","url":"https://...","kind":"rss"|"telegram","area":"law"|"hazard","why":"зачем это нам, одной фразой","confidence":"known"|"guess"}]}`;

interface Candidate {
  name?: string;
  url?: string;
  kind?: string;
  area?: string;
  why?: string;
  confidence?: string;
}

export interface FilterResult {
  kept: Candidate[];
  dropped: Array<{ url: string; why: string }>;
}

/** Адреса, уже стоящие в разведке: сравниваем по хосту с путём, без схемы и хвостов. */
const EXISTING_URLS = [
  'simonwillison.net/atom/everything/', 'huggingface.co/blog/feed.xml',
  'marktechpost.com/feed/', 'hnrss.org/newest', 'habr.com/ru/rss/hub/artificial_intelligence/all/',
  'openai.com/news/rss.xml', 'blog.google/technology/ai/rss/', 'deepmind.google/blog/rss.xml',
  'skift.com/feed/', 'producthunt.com/feed',
  'tourprom.ru/feed/rss.xml', 'ratanews.ru/rss.xml',
  't.me/s/ru_rst', 't.me/s/minec_tourism', 't.me/s/vibecoding_tg',
];

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Детерминированная отбраковка. Модель не решает ничего: она предложила, а
 * пройдёт ли предложение дальше — вопрос формы, а не убедительности.
 */
export function filterCandidates(raw: unknown): FilterResult {
  const kept: Candidate[] = [];
  const dropped: Array<{ url: string; why: string }> = [];
  const seen = new Set<string>();

  const list = Array.isArray((raw as { candidates?: unknown })?.candidates)
    ? ((raw as { candidates: unknown[] }).candidates)
    : [];

  for (const item of list) {
    const c = (item ?? {}) as Candidate;
    const url = typeof c.url === 'string' ? c.url.trim() : '';
    const label = url || String(c.name ?? 'без адреса');

    if (!url) { dropped.push({ url: label, why: 'адреса нет вовсе' }); continue; }

    let parsed: URL;
    try { parsed = new URL(url); } catch { dropped.push({ url: label, why: 'адрес не разбирается' }); continue; }
    if (parsed.protocol !== 'https:') { dropped.push({ url: label, why: 'не https' }); continue; }

    if (c.kind !== 'rss' && c.kind !== 'telegram') {
      dropped.push({ url: label, why: `вид источника «${String(c.kind)}» мы читать не умеем` });
      continue;
    }
    // Telegram читается ТОЛЬКО публичным превью. Приглашение t.me/+... — это
    // закрытый чат: читать его нельзя по построению, а не «пока не настроили».
    if (c.kind === 'telegram' && !/^https:\/\/t\.me\/s\/[A-Za-z0-9_]+$/.test(url)) {
      dropped.push({ url: label, why: 'Telegram не в форме t.me/s/<канал> — закрытый или приглашение' });
      continue;
    }
    if (c.area !== 'law' && c.area !== 'hazard') {
      dropped.push({ url: label, why: `область «${String(c.area)}» не запрашивалась` });
      continue;
    }

    const norm = normalizeUrl(url);
    if (EXISTING_URLS.some(e => norm === normalizeUrl(e))) {
      dropped.push({ url: label, why: 'уже стоит в разведке' });
      continue;
    }
    if (seen.has(norm)) { dropped.push({ url: label, why: 'повтор внутри ответа' }); continue; }
    seen.add(norm);

    kept.push({ ...c, url });
  }

  return { kept, dropped };
}

/** Приговор переписи по одному адресу. */
export type CensusVerdict = 'feed_ok' | 'not_a_feed' | 'refused_here' | 'dead' | 'unreachable';

/**
 * Приговор по ответу сервера. Отдельный `refused_here` — не педантизм: раннер
 * стоит ВНЕ РФ, и часть государственных сайтов закрывает зарубежные адреса.
 * Назвать это «лентой нет» значило бы похоронить живой источник по признаку
 * нашего местоположения — зеркало нашей же беды с t.me, закрытым с прода.
 */
export function judgeCensus(status: number | null, contentType: string, bytes: number): CensusVerdict {
  if (status === null) return 'unreachable';
  if (status === 403 || status === 451 || status === 401) return 'refused_here';
  if (status === 404 || status === 410) return 'dead';
  if (status < 200 || status >= 400) return 'unreachable';
  const ct = contentType.toLowerCase();
  const looksFeed = ct.includes('xml') || ct.includes('rss') || ct.includes('atom');
  // Telegram-превью сюда не попадает: у него свой разбор (посты в разметке),
  // потому что оно отдаёт HTML по построению.
  if (!looksFeed) return 'not_a_feed';
  // Пустой XML — это страница-заглушка, а не лента: 200 сам по себе ничего не
  // обещает, и «лента есть» должно опираться на содержимое.
  return bytes > 200 ? 'feed_ok' : 'not_a_feed';
}

async function census(url: string, isTelegram: boolean): Promise<{ verdict: CensusVerdict; detail: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TourHab/1.0 (Scout source census)' },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    if (isTelegram) {
      // У превью канала признак жизни — наличие постов в разметке.
      const posts = (body.match(/tgme_widget_message/g) ?? []).length;
      return posts > 0
        ? { verdict: 'feed_ok', detail: `превью канала, постов: ${posts}` }
        : { verdict: 'not_a_feed', detail: `HTTP ${res.status}, постов в превью нет` };
    }
    const verdict = judgeCensus(res.status, ct, body.length);
    return { verdict, detail: `HTTP ${res.status}, ${ct || 'без типа'}, ${body.length} байт` };
  } catch (e) {
    return { verdict: 'unreachable', detail: (e as Error).message.slice(0, 120) };
  }
}

async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error('OPENROUTER_API_KEY не задан — спрашивать нечем. Это не «источников не нашлось».');
    process.exit(1);
  }
  const model = (process.argv[2] || '').trim() || DEFAULT_MODEL;

  const user = [
    'СЕЙЧАС В РАЗВЕДКЕ (не предлагай это снова):',
    ...CURRENT_SOURCES.map(s => `- ${s}`),
    '',
    'УЖЕ ПРОВЕРЕНО И МЕРТВО (не предлагай это, мы измеряли):',
    ...GRAVEYARD.map(s => `- ${s}`),
    '',
    'Нужны источники областей law и hazard. Лавинная опасность — самый нужный пробел.',
  ].join('\n');

  const started = Date.now();
  const res = await fetch(OPENROUTER, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...openRouterAttribution('source-discovery'),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    console.error(`OpenRouter ответил HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    process.exit(1);
  }

  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const answer = json.choices?.[0]?.message?.content ?? '';
  console.log(`Модель: ${model}, ответ за ${((Date.now() - started) / 1000).toFixed(1)} с`);
  if (json.usage) {
    console.log(`Токены: вход ${json.usage.prompt_tokens ?? '?'}, выход ${json.usage.completion_tokens ?? '?'} (цена — по прайсу модели × ${RUB_PER_USD})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    console.error('Модель ответила не-JSON. Первые 500 знаков ответа:');
    console.error(answer.slice(0, 500));
    process.exit(1);
  }

  const { kept, dropped } = filterCandidates(parsed);
  console.log(`\nПредложено: ${kept.length + dropped.length}, прошло форму: ${kept.length}, отброшено: ${dropped.length}`);
  for (const d of dropped) console.log(`  отброшено: ${d.url} — ${d.why}`);

  console.log('\n── Перепись: приговор выносит сервер, а не модель ──');
  const verified: Array<Candidate & { verdict: CensusVerdict; detail: string }> = [];
  for (const c of kept) {
    const r = await census(c.url as string, c.kind === 'telegram');
    verified.push({ ...c, ...r });
    console.log(`  ${r.verdict.padEnd(13)} ${c.area}  ${c.url}  (${r.detail})`);
    await new Promise(r2 => setTimeout(r2, 400));
  }

  const alive = verified.filter(v => v.verdict === 'feed_ok');
  const recheck = verified.filter(v => v.verdict === 'refused_here');

  console.log(`\nЖИВЫЕ (можно вносить): ${alive.length}`);
  for (const a of alive) console.log(`  ${a.area}  ${a.name} — ${a.url}\n      ${a.why ?? ''}`);

  console.log(`\nОТКАЗ С РАННЕРА, нужна проверка с прода: ${recheck.length}`);
  // Раннер вне РФ; для государственных сайтов это ожидаемый исход, и он НЕ
  // означает, что ленты нет. Список печатается готовым к переписи с прода.
  for (const r of recheck) console.log(`  ${r.area}  ${r.url}`);

  console.log('\nВ базу и в состав источников не записано ничего: вносит человек.');
}

if (require.main === module) {
  main().catch((e) => { console.error('Разбор упал:', (e as Error).message); process.exit(1); });
}
