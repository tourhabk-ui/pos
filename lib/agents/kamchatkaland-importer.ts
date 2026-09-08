/**
 * lib/agents/kamchatkaland-importer.ts
 *
 * Тематические статьи о природе Камчатки с kamchatkaland.ru/note/ —
 * 27 текстов по 1200-4500 слов: вулканы, источники, гейзеры, озёра, реки,
 * водопады, бухты, животные, растения, парки, посёлки, история.
 *
 * Каждая статья → строка в `articles`, то есть в СВОЙ раздел (/articles,
 * миграция 848). Кузьмич берёт их оттуда же как справочный контекст.
 *
 * ── Что здесь было до 08.09 и почему это был замкнутый круг ────────────────
 *
 * Импортёр писал статьи в `kamchatka_routes` видимыми записями. То есть
 * «История Камчатки» и «Когда лучше ехать на Камчатку» предлагались туристу
 * как МАРШРУТ — как то, по чему можно пойти. Шапка при этом обещала
 * `agent_route_knowledge (kind='article')`, чего код не делал никогда: три
 * разных ответа на вопрос «где живёт статья» — в шапке, в коде и в §4.1.
 *
 * Круг замыкался так. Шаг ремонта `source_note` (lib/services/data-repair.ts)
 * находит записи с адресом источника вида `/note`, переносит текст в
 * `articles` и убирает строку из справочника маршрутов. Импортёр же искал
 * «что уже есть» в `kamchatka_routes` — и после каждой уборки видел пустоту и
 * затягивал все 27 обратно. Уборщик и загрязнитель ходили по расписанию:
 * ремонт по кнопке, импорт ежедневно в 00:00 UTC.
 *
 * Поэтому исправлен ИСТОЧНИК, а не последствие: статья пишется сразу туда,
 * куда её потом всё равно перенесёт ремонт, и «что уже есть» спрашивается
 * там же.
 *
 * ── Счётчики ──────────────────────────────────────────────────────────────
 *
 * Прежний код возвращал 'inserted' при любом ненулевом rowCount, а UPSERT
 * даёт rowCount = 1 и на вставке, и на обновлении: ветка 'updated' была
 * недостижима, и отчёт сообщал вставки там, где шли обновления. Теперь род
 * операции спрашивается у самой базы — `RETURNING (xmax = 0)`: у вставленной
 * строки xmax нулевой, у обновлённой конфликтом — нет.
 *
 * ── Чужой адрес занят ─────────────────────────────────────────────────────
 *
 * `articles.slug` уникален на весь раздел, а в нём уже лежат статьи, которые
 * ремонт перенёс из маршрутов (источник visitkamchatka). Совпадение адреса
 * при РАЗНЫХ источниках — не повод переписать чужой текст своим: обновление
 * ограничено условием на источник, а такая статья считается пропущенной и
 * называется в ответе отдельным числом, а не растворяется в skipped.
 */

import { pool } from '@/lib/db-pool';

type JSDOMConstructor = new (html: string) => { window: { document: Document } };
const JSDOM = (require('jsdom') as { JSDOM: JSDOMConstructor }).JSDOM;

const BASE = 'https://kamchatkaland.ru';
const SOURCE_NAME = 'kamchatkaland.ru';

export interface KamchatkalandResult {
  inserted: number;
  updated: number;
  skipped: number;
  /** Адрес занят статьёй ДРУГОГО источника — чужой текст не переписан. */
  taken_by_other_source: number;
  errors: number;
  duration_ms: number;
}

/**
 * Статьи и рубрика раздела.
 *
 * Рубрика взята из ТЕМЫ самого заголовка, а не из прежней колонки `category`
 * (`trekking`, `ekskursii`, `medvedi`). Та категория выбиралась под строку
 * МАРШРУТА — она отвечала на вопрос «каким видом активности туда идут», и в
 * читательском разделе «Водопады Камчатки» под рубрикой «треккинг» были бы
 * выдуманной рубрикой, а не переводом существующей.
 *
 * У «Разного о Камчатке» темы нет намеренно: `null` собирается в «Разное»
 * (lib/articles/queries.ts), и это честнее приписанной наугад рубрики.
 */
const ARTICLES: Array<{ slug: string; topic: string | null }> = [
  { slug: 'vulkany-kamchatki',                  topic: 'Вулканы и гейзеры' },
  { slug: 'dolina-gejzerov',                    topic: 'Вулканы и гейзеры' },
  { slug: 'goryachie-istochniki',               topic: 'Вулканы и гейзеры' },
  { slug: 'ozera',                              topic: 'Вода' },
  { slug: 'reki',                               topic: 'Вода' },
  { slug: 'reka-kamchatka',                     topic: 'Вода' },
  { slug: 'vodopady',                           topic: 'Вода' },
  { slug: 'buhty',                              topic: 'Вода' },
  { slug: 'ozero-azhabachje',                   topic: 'Вода' },
  { slug: 'parki',                              topic: 'Природа' },
  { slug: 'zhivotnye',                          topic: 'Природа' },
  { slug: 'morskoj-mir-kamchatki',              topic: 'Природа' },
  { slug: 'rasteniya',                          topic: 'Природа' },
  { slug: 'flora',                              topic: 'Природа' },
  { slug: 'derevya-kamchatki',                  topic: 'Природа' },
  { slug: 'relef-kamchatki',                    topic: 'Природа' },
  { slug: 'ekologicheskie-problemyi-kamchatki', topic: 'Природа' },
  { slug: 'territoriya-kamchatki',              topic: 'Край и посёлки' },
  { slug: 'goroda-poselenija',                  topic: 'Край и посёлки' },
  { slug: 'esso',                               topic: 'Край и посёлки' },
  { slug: 'poselok-klyuchi',                    topic: 'Край и посёлки' },
  { slug: 'nizhnekamchatsk',                    topic: 'Край и посёлки' },
  { slug: 'ug',                                 topic: 'Край и посёлки' },
  { slug: 'zima',                               topic: 'Сезон и поездка' },
  { slug: 'kogda-luchshe-ehat-na-kamchatku',    topic: 'Сезон и поездка' },
  { slug: 'istoriya',                           topic: 'История' },
  { slug: 'raznoe',                             topic: null },
];

// ── Заголовки статей для читаемых title ────────────────────────────

const ARTICLE_TITLES: Record<string, string> = {
  'vulkany-kamchatki':                'Вулканы Камчатки',
  'dolina-gejzerov':                  'Долина Гейзеров',
  'goryachie-istochniki':             'Горячие источники Камчатки',
  'ozera':                            'Озёра Камчатки',
  'reki':                             'Реки Камчатки',
  'reka-kamchatka':                   'Река Камчатка',
  'vodopady':                         'Водопады Камчатки',
  'buhty':                            'Бухты Камчатки',
  'parki':                            'Природные парки Камчатки',
  'zhivotnye':                        'Животные Камчатки',
  'morskoj-mir-kamchatki':            'Морской мир Камчатки',
  'rasteniya':                        'Растения Камчатки',
  'flora':                            'Флора Камчатки',
  'derevya-kamchatki':                'Деревья Камчатки',
  'relef-kamchatki':                  'Рельеф Камчатки',
  'territoriya-kamchatki':            'Территория Камчатки',
  'goroda-poselenija':                'Города и посёлки Камчатки',
  'esso':                             'Поселок Эссо',
  'poselok-klyuchi':                  'Поселок Ключи',
  'nizhnekamchatsk':                  'Нижнекамчатск',
  'ozero-azhabachje':                 'Озеро Азабачье',
  'zima':                             'Зима на Камчатке',
  'kogda-luchshe-ehat-na-kamchatku':  'Когда лучше ехать на Камчатку',
  'istoriya':                         'История Камчатки',
  'ekologicheskie-problemyi-kamchatki': 'Экологические проблемы Камчатки',
  'raznoe':                           'Разное о Камчатке',
  'ug':                               'Юг Камчатки',
};

// ── Скачать и распарсить статью ────────────────────────────────────

async function fetchArticle(slug: string): Promise<string | null> {
  const url = `${BASE}/note/${slug}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TourHabBot/1.0 (vedarai.ru; knowledge enrichment)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Убрать навигацию, скрипты, футер
    ['nav', 'header', 'footer', 'script', 'style', 'noscript', '.menu', '.footer', '.header'].forEach(sel => {
      doc.querySelectorAll(sel).forEach((el: Element) => el.remove());
    });

    // Собрать текст из параграфов
    const paragraphs: string[] = [];
    doc.querySelectorAll('p, h2, h3, li').forEach((el: Element) => {
      const text = el.textContent?.trim() ?? '';
      if (text.length > 30) paragraphs.push(text);
    });

    const text = paragraphs.join('\n\n').replace(/\s{3,}/g, '\n\n').trim();
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

// ── Запись статьи в раздел статей ──────────────────────────────────

type UpsertOutcome = 'inserted' | 'updated' | 'taken_by_other_source';

async function upsertArticle(
  slug: string,
  body: string,
  meta: typeof ARTICLES[number],
): Promise<UpsertOutcome> {
  const title = ARTICLE_TITLES[slug] ?? slug.replace(/-/g, ' ');
  const url = `${BASE}/note/${slug}`;

  // Род операции спрашивается у базы: xmax = 0 у вставленной строки, ненулевой
  // у обновлённой по конфликту. Считать по rowCount нельзя — он равен единице
  // в обоих случаях, и прежний отчёт поэтому не знал ни одного обновления.
  //
  // Условие на источник в DO UPDATE защищает чужой текст: адрес в разделе один
  // на всех, а статьи туда попадают ещё и из ремонта справочника маршрутов.
  const { rows } = await pool.query<{ inserted: boolean }>(
    `INSERT INTO articles (slug, title, body, topic, source_url, source_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET
       title       = EXCLUDED.title,
       body        = COALESCE(EXCLUDED.body, articles.body),
       topic       = COALESCE(EXCLUDED.topic, articles.topic),
       source_url  = COALESCE(EXCLUDED.source_url, articles.source_url),
       updated_at  = NOW()
     WHERE articles.source_name = EXCLUDED.source_name
     RETURNING (xmax = 0) AS inserted`,
    [slug, title, body, meta.topic, url, SOURCE_NAME],
  );

  const row = rows[0];
  if (!row) return 'taken_by_other_source';
  return row.inserted ? 'inserted' : 'updated';
}

// ── Главная функция ────────────────────────────────────────────────

export async function runKamchatkalandImporter(batchSize = 10): Promise<KamchatkalandResult> {
  const start = Date.now();
  let inserted = 0, updated = 0, skipped = 0, takenByOther = 0, errors = 0;

  // «Что уже есть» спрашивается в разделе статей — там же, где статья и живёт.
  // Пока этот вопрос задавался справочнику маршрутов, ответ был всегда «ничего
  // нет»: ремонт уносил строки оттуда, и импортёр тянул все 27 заново.
  const { rows: existingRows } = await pool.query<{ slug: string }>(
    `SELECT slug FROM articles WHERE source_name = $1`,
    [SOURCE_NAME],
  );
  const existing = new Set(existingRows.map((r) => r.slug));

  const toProcess = ARTICLES.filter((a) => !existing.has(a.slug)).slice(0, batchSize);

  for (const article of toProcess) {
    const body = await fetchArticle(article.slug);
    if (!body) {
      console.error(`  fetch returned null for ${article.slug}`);
      errors++;
      continue;
    }
    try {
      const result = await upsertArticle(article.slug, body, article);
      if (result === 'inserted') inserted++;
      else if (result === 'updated') updated++;
      else {
        takenByOther++;
        console.error(`  адрес /articles/${article.slug} занят статьёй другого источника — не переписываем`);
      }
    } catch (e) {
      console.error(`  upsert error for ${article.slug}:`, e instanceof Error ? e.message : e);
      errors++;
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // skipped — статьи, до которых не дошла очередь этой партии: не отказ и не
  // работа, но и не ноль, иначе размер партии выглядел бы полным охватом.
  skipped = Math.max(0, ARTICLES.length - existing.size - toProcess.length);

  return {
    inserted, updated, skipped,
    taken_by_other_source: takenByOther,
    errors,
    duration_ms: Date.now() - start,
  };
}
