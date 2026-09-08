/**
 * lib/agents/places-enricher.ts
 *
 * Обогащает места Камчатки реальными описаниями.
 *
 * Алгоритм:
 * 1. Скачивает страницы с описаниями мест с нескольких Камчатских сайтов
 * 2. Извлекает пары (название → описание)
 * 3. Сопоставляет с записями в agent_route_knowledge по заголовку
 * 4. Каждое описание прогоняет через AI-рерайт (сохранить факты, свои слова)
 * 5. Пишет описание и строку происхождения в `description_provenance`
 *
 * Источники: extraguide.ru, tur-ray.ru, spkam.com, bolshayastrana.com
 *
 * ── Разбор 08.09: второй писатель жил слабее первого ───────────────────────
 *
 * Описания мест пишут двое — Editor (маршруты и места) и этот обогатитель, — и
 * второй делал ту же работу по худшим правилам:
 *
 *   • звал `callAIFast` — гонку, где побеждает самая быстрая мелкая модель.
 *     В шапке `providers.ts` этот случай уже описан: так публичные тексты
 *     писала мелкая модель. Теперь тот же `callAIQualityOrNull`, что у Editor;
 *   • не писал происхождение: «сколько описаний сочинено и откуда» по местам
 *     ответить было нечем, хотя ради этого ответа заведена таблица
 *     `description_provenance` (миграция 911). Теперь пишет — вместе с
 *     адресом страницы-источника;
 *   • сопоставлял имена своей меркой (`includes` → 0.85, порог 0.65). Чужой
 *     текст на карточке места опаснее пустой карточки: платформа о
 *     безопасности, и описание не того объекта — это ложь о местности.
 *     Мерка теперь общая с привязкой мест к маршрутам
 *     (`nameMatchScore`, `lib/routes/place-link.ts`) и строгая: см. ниже;
 *   • глушил отказ каждого скрейпера. Теперь каждый назван поимённо.
 */

import { pool } from '@/lib/db-pool';
import { callAIQualityOrNull, isWaterfallErrorResponse } from '@/lib/ai/providers';
import { nameMatchScore } from '@/lib/routes/place-link';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { verbalizedInstruction, parseVerbalizedSamples, pickLeastTypical, looksLikeVerbalizedJson } from '@/lib/ai/verbalized-sampling';
import type { ChatMessage } from '@/lib/ai/prompts';

type JSDOMConstructor = new (html: string) => { window: { document: Document } };
const JSDOM = (require('jsdom') as { JSDOM: JSDOMConstructor }).JSDOM;

export interface PlacesEnricherResult {
  matched: number;
  enriched: number;
  skipped: number;
  errors: number;
  duration_ms: number;
}

interface PlaceDesc {
  title: string;
  description: string;
  /** Адрес страницы, с которой взят текст, — для строки происхождения. */
  sourceUrl: string;
  sourceName: string;
}

/** Скрейпер вместе со своим именем: отказ обязан называть, КТО не ответил. */
interface Scraper {
  name: string;
  run: () => Promise<PlaceDesc[]>;
}

// ── Скрейп источников ─────────────────────────────────────────────

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const EXTRAGUIDE_URL = 'https://extraguide.ru/russia/kamchatka/sights/';
const TURRAY_URL = 'https://tur-ray.ru/dostoprimechatelnosti-kamchatki.html';
const SPKAM_URL = 'https://spkam.com/stati-o-kamchatke/dostoprimechatelnosti/';

async function scrapeExtraguide(): Promise<PlaceDesc[]> {
  const html = await fetchPage(EXTRAGUIDE_URL);
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const results: PlaceDesc[] = [];

  doc.querySelectorAll('h2, h3').forEach((heading: Element) => {
    const title = heading.textContent?.trim() ?? '';
    if (!title || title.length < 3) return;
    // Берём текст следующих параграфов
    const paragraphs: string[] = [];
    let next = heading.nextElementSibling;
    while (next && !['H2', 'H3'].includes(next.tagName) && paragraphs.join('').length < 1000) {
      if (next.tagName === 'P') {
        const t = next.textContent?.trim() ?? '';
        if (t.length > 30) paragraphs.push(t);
      }
      next = next.nextElementSibling;
    }
    if (paragraphs.length > 0) {
      results.push({ title, description: paragraphs.join(' '), sourceUrl: EXTRAGUIDE_URL, sourceName: 'extraguide.ru' });
    }
  });

  return results;
}

async function scrapeTurRay(): Promise<PlaceDesc[]> {
  const html = await fetchPage(TURRAY_URL);
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const results: PlaceDesc[] = [];

  doc.querySelectorAll('h2, h3').forEach((heading: Element) => {
    const title = heading.textContent?.replace(/\d+\./g, '').trim() ?? '';
    if (!title || title.length < 5) return;
    const paragraphs: string[] = [];
    let next = heading.nextElementSibling;
    while (next && !['H2', 'H3'].includes(next.tagName) && paragraphs.join('').length < 1000) {
      if (next.tagName === 'P') {
        const t = next.textContent?.trim() ?? '';
        if (t.length > 30) paragraphs.push(t);
      }
      next = next.nextElementSibling;
    }
    if (paragraphs.length > 0) {
      results.push({ title, description: paragraphs.join(' '), sourceUrl: TURRAY_URL, sourceName: 'tur-ray.ru' });
    }
  });

  return results;
}

async function scrapeSpkam(): Promise<PlaceDesc[]> {
  const html = await fetchPage(SPKAM_URL);
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const results: PlaceDesc[] = [];

  doc.querySelectorAll('h2, h3').forEach((heading: Element) => {
    const title = heading.textContent?.replace(/^\d+\.\s*/, '').trim() ?? '';
    if (!title || title.length < 5) return;
    const paragraphs: string[] = [];
    let next = heading.nextElementSibling;
    while (next && !['H2', 'H3'].includes(next.tagName) && paragraphs.join('').length < 800) {
      if (next.tagName === 'P') {
        const t = next.textContent?.trim() ?? '';
        if (t.length > 30) paragraphs.push(t);
      }
      next = next.nextElementSibling;
    }
    if (paragraphs.length > 0) {
      results.push({ title, description: paragraphs.join(' '), sourceUrl: SPKAM_URL, sourceName: 'spkam.com' });
    }
  });

  return results;
}

// ── Нечёткое сопоставление названий ──────────────────────────────

/**
 * Сходство имён — общей меркой платформы (`nameMatchScore`), а не своей.
 *
 * Мерка направленная: она считает, какая доля значимых слов ОДНОГО имени
 * нашлась в другом. Здесь спрашивается в обе стороны и берётся худший ответ:
 * односторонняя проверка объявила бы «Ключевской вулкан» совпадением с
 * «Ключевская сопка (маршрут через Апахончич)» и приписала бы месту чужой
 * текст.
 *
 * Прежняя мерка жила здесь своя: `includes` давал 0.85, порог стоял 0.65 — то
 * есть достаточно было ОДНОГО общего длинного слова из двух. Родовые слова
 * («вулкан», «источники», «долина») при этом отсекались списком из семи штук,
 * тогда как у общей мерки их полсотни.
 */
export function bidirectionalNameScore(a: string, b: string): number {
  return Math.min(nameMatchScore(a, b), nameMatchScore(b, a));
}

/**
 * Порог: совпасть должны ВСЕ значимые слова с обеих сторон.
 *
 * Строгость выбрана ценой ошибки, а не вкусом. Пропущенное место остаётся без
 * описания — его допишет Editor или человек. Приписанный чужой текст читается
 * туристом как правда о местности, по которой он пойдёт, и обнаружить подмену
 * ему нечем: описание выглядит связным и уверенным.
 */
export const NAME_MATCH_MIN = 1;

// ── AI-рерайт описания ─────────────────────────────────────────────

export async function rewriteDescription(title: string, rawDesc: string): Promise<string | null> {
  if (rawDesc.trim().length < 100) return null;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты редактор платформы TourHab (туризм Камчатки). Главная цель платформы — безопасность туристов, поэтому точность важнее красоты текста.
Задача: перефразировать переданное описание природного объекта своими словами.

Жёсткие правила фактов:
- Используй ТОЛЬКО факты из исходного текста. НЕ добавляй ничего от себя: ни высот, ни координат, ни температур, ни расстояний, ни сведений о флоре/фауне, ни оценок сложности и безопасности, если их нет в источнике.
- Конкретные числа и собственные названия переноси точно, без округления и подмены.
- НЕ добавляй и не усиливай утверждения о безопасности ("безопасно", "брода нет") — даже если так "логично". Выдуманный факт о безопасности опасен для туриста.
- Если в исходнике есть реклама, цены, телефоны, призывы купить тур — отбрось их, оставь только описание места.
- Если фактов мало — пусть текст будет короче, не компенсируй объём выдумкой.

Стиль: точный и спокойный (при конфликте точности и "живости" выбирай точность), без рекламных штампов, без emoji, без markdown.
Объём: 2-3 абзаца, 150-280 слов, на русском. Отвечай только переписанным текстом, без вступлений.`,
    },
    {
      role: 'user',
      content: `Объект: ${title}\n\nИсходный текст (перефразируй, не добавляя ничего сверх него):\n${rawDesc.slice(0, 1500)}

${verbalizedInstruction(3)}
Каждый text — это готовый переписанный текст по правилам выше (только факты из источника, без выдумки). Варианты отличаются подачей, но все — фактически честные.`,
    },
  ];
  try {
    // Качественный водопад, а не гонка: текст читают люди, и читают его как
    // правду о месте. `callAIFast` побеждает самой быстрой мелкой моделью —
    // ровно тот случай, что описан в шапке providers.ts.
    const answer = await callAIQualityOrNull(messages, { maxTokens: 1600 });
    const raw = answer && !isWaterfallErrorResponse(answer) ? answer.trim() : null;
    if (!raw) return null;
    // Verbalized Sampling: наименее шаблонный валидный вариант. Fallback на сырой
    // ответ — ТОЛЬКО если это НЕ (битый) VS-JSON, иначе сохранили бы сырой
    // обрезанный массив как описание (баг на проде). Битый VS-JSON → null,
    // caller пропустит (rewriteDescription может вернуть null).
    const picked = pickLeastTypical(parseVerbalizedSamples(raw), 100);
    return picked ?? (looksLikeVerbalizedJson(raw) ? null : raw);
  } catch (e) {
    console.error('rewrite error:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ── Загрузить места из БД без описания ────────────────────────────

interface DBPlace {
  id: string;
  title: string;
  /** Сколько символов было до правки. NULL — описания не было вовсе. */
  prev_chars: number | null;
}

async function loadPlacesNeedingDesc(limit: number): Promise<DBPlace[]> {
  const { rows } = await pool.query<DBPlace>(
    `SELECT id, title, LENGTH(description) AS prev_chars FROM agent_route_knowledge
     WHERE kind = 'place'
       AND (description IS NULL OR LENGTH(description) < 300)
       AND title NOT ILIKE '%экскурси%'
       AND title NOT ILIKE '%маршрут%'
       AND title NOT ILIKE '%восхождени%'
       AND title NOT ILIKE '%забег%'
       AND title NOT ILIKE '%приключени%'
       AND title NOT ILIKE '%вид на%'
       AND LENGTH(title) > 5
     ORDER BY RANDOM()
     LIMIT $1`,
    [limit],
  );
  return rows;
}

// ── Сохранить описание в БД ────────────────────────────────────────

interface DescriptionSource {
  title: string;
  url: string;
  name: string;
  nameScore: number;
}

/**
 * Описание и строка происхождения.
 *
 * Происхождение — отдельным запросом и с собственным `catch`: отказ журнала не
 * отменяет уже записанное описание, но и не молчит (тот же порядок, что у
 * Editor). Без этой строки на вопрос «откуда взялся текст на карточке места»
 * ответить нечем — ни для сверки факта, ни для авторских прав.
 */
async function saveDescription(
  place: DBPlace,
  description: string,
  previousChars: number | null,
  source: DescriptionSource,
): Promise<void> {
  await pool.query(
    `UPDATE agent_route_knowledge SET description = $1 WHERE id = $2`,
    [description, place.id],
  );
  try {
    await pool.query(
      `INSERT INTO description_provenance
         (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
       VALUES ($1, 'place', $2, 'places-enricher', $3::jsonb, 1, $4, $5)`,
      [place.id, place.title, JSON.stringify([source]), description.length, previousChars],
    );
  } catch (err) {
    logSwallowedFailure('places-enricher', `происхождение «${place.title}»`, err);
  }
}

// ── Главная функция ────────────────────────────────────────────────

export async function runPlacesEnricher(batchSize = 30): Promise<PlacesEnricherResult> {
  const start = Date.now();
  let matched = 0, enriched = 0, skipped = 0, errors = 0;

  // 1. Загрузить описания из источников
  const sourceDescs: PlaceDesc[] = [];
  const scrapers: Scraper[] = [
    { name: 'extraguide.ru', run: scrapeExtraguide },
    { name: 'tur-ray.ru', run: scrapeTurRay },
    { name: 'spkam.com', run: scrapeSpkam },
  ];
  for (const scraper of scrapers) {
    try {
      const items = await scraper.run();
      // Ноль записей при успешном ответе — тоже отказ: страница жива, а
      // разметка сменилась, и молчание тут неотличимо от «нечего брать».
      if (items.length === 0) console.error(`[places-enricher] ${scraper.name}: страница отдана, записей не извлечено`);
      sourceDescs.push(...items);
    } catch (err) {
      logSwallowedFailure('places-enricher', `источник ${scraper.name}`, err);
    }
  }

  if (sourceDescs.length === 0) {
    return { matched: 0, enriched: 0, skipped: 0, errors: 1, duration_ms: Date.now() - start };
  }

  // 2. Загрузить места из БД
  const dbPlaces = await loadPlacesNeedingDesc(Math.min(batchSize * 5, 300));

  // 3. Сопоставить и обогатить
  let processed = 0;
  for (const place of dbPlaces) {
    if (processed >= batchSize) break;

    // Найти совпадение в источниках: общей меркой, в обе стороны, строго.
    let bestMatch: PlaceDesc | null = null;
    let bestScore = 0;
    for (const src of sourceDescs) {
      const score = bidirectionalNameScore(place.title, src.title);
      if (score > bestScore && score >= NAME_MATCH_MIN) {
        bestScore = score;
        bestMatch = src;
      }
    }

    if (!bestMatch) {
      skipped++;
      continue;
    }

    matched++;
    processed++;

    try {
      const rewritten = await rewriteDescription(place.title, bestMatch.description);
      if (!rewritten || rewritten.length < 100) {
        console.error(`rewrite empty for "${place.title}" (len=${rewritten?.length ?? 0})`);
        skipped++;
        continue;
      }
      await saveDescription(place, rewritten, place.prev_chars, {
        title: bestMatch.title,
        url: bestMatch.sourceUrl,
        name: bestMatch.sourceName,
        nameScore: bestScore,
      });
      enriched++;
    } catch (err) {
      logSwallowedFailure('places-enricher', `описание «${place.title}»`, err);
      errors++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  return { matched, enriched, skipped, errors, duration_ms: Date.now() - start };
}
