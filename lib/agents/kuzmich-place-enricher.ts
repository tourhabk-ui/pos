/**
 * lib/agents/kuzmich-place-enricher.ts
 *
 * Генерирует kuzmich_review для мест Камчатки.
 *
 * kuzmich_review — личный взгляд Кузьмича на место: 1-2 предложения
 * в голосе опытного местного гида. Акцент на безопасности, характере
 * места, том что турист не узнает из Википедии.
 *
 * Алгоритм:
 * 1. Выбирает places WHERE kuzmich_review IS NULL AND is_visible = true
 * 2. Для каждого места — опциональный скрейп 2GIS через Bright Data
 * 3. Генерирует review через callAIWaterfall()
 * 4. Сверяет заметку с данными, по которым её писали (lib/kuzmich/review-claims)
 * 5. Сохраняет в places.kuzmich_review — только заметку без улик
 *
 * Шаг 4 — 14.10, слово владельца «кузьмич навыдумывал много». Заметка о
 * Вачкажце утверждала «часа четыре идти по осыпи», «три вершины» и медведей,
 * которых в данных места не было, — промпт запрещал ровно это, и запрет не
 * сработал: жанр «личной заметки проводника» зовёт к подробностям из опыта,
 * которого у модели нет. Проверка после модели не спорит с промптом, а
 * заменяет надежду на него. По той же причине место с описанием-дневником
 * («я поднялся», «мы шли») заметку не получает вовсе: пересказ выдумки —
 * та же выдумка.
 *
 * С 22.10 новых заметок нет вовсе — слово владельца «отключи агента
 * выдумывающкюего описание мест» (lib/places/model-place-text.ts). Шаг 4 для
 * стоящих заметок работает дальше: снятое им модель больше не переписывает.
 */

import { honestSafetyFields, asProfileSource } from '@/lib/safety/profile-source';
import { pool } from '@/lib/db-pool';
import { callAIWaterfall, isWaterfallErrorResponse } from '@/lib/ai/providers';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';
import type { ChatMessage } from '@/lib/ai/prompts';
import { locationTypeLabelLower } from '@/lib/places/location-types';
import { descriptionVoice } from '@/lib/places/description-voice';
import { reviewClaims, reviewRewriteReason, type RewriteReason } from '@/lib/kuzmich/review-claims';
import { placeZoneLabel } from '@/lib/places/zone-labels';
import { MODEL_WRITES_PLACE_TEXT } from '@/lib/places/model-place-text';

export interface KuzmichPlaceEnricherResult {
  processed: number;
  enriched: number;
  skipped: number;
  /** Заметки с уликой выдумки — не сохранены (место останется без заметки до следующего прогона). */
  rejected: number;
  errors: number;
  /** Стоявшие заметки, снятые перепроверкой в очередь на перезапись. */
  reset: number;
  /** Перепроверка не выполнилась — «снято 0» тогда не значит «снимать нечего». */
  recheck_failed: boolean;
  /**
   * Новые заметки не пишутся — слово владельца 22.10 (lib/places/model-place-text.ts).
   * Ноль `enriched` тогда значит «выключено», а не «писать некому».
   */
  paused: boolean;
  duration_ms: number;
}

interface ReviewedPlaceRow {
  id: string;
  name: string;
  description: string | null;
  kuzmich_review: string;
  hazard_types: string[] | null;
  profile_source: string | null;
  altitude_m: number | null;
}

/**
 * Перепроверка уже стоящих заметок — тем же правилом, которым агент судит
 * новую (14.10, слово владельца «1 да»).
 *
 * Перепись 14.10 (`/api/cron/kuzmich-review-census`): 169 из 375 заметок
 * говорили то, чего нет в данных места, — опасности из шаблона 070, числа,
 * рассказ от первого лица. Проверка после модели остановила НОВЫЕ выдумки, а
 * стоявшие она не видела. Теперь каждый прогон сначала снимает заметки, не
 * прошедшие проверку, в NULL — карточка перестаёт их показывать сразу, — и
 * они встают в очередь этого же агента: где модель скажет верно, заметка
 * вернётся, а выдумку проверка не пропустит.
 *
 * Снимается ровно тот текст, что проверялся (`kuzmich_review = $текст`):
 * заметку, исправленную за эти секунды рукой, перепроверка не тронет. Пустая
 * строка — заметка, снятая решением человека, — не перепроверяется вовсе.
 */
export async function recheckExistingReviews(): Promise<{ checked: number; reset: number; reasons: Record<RewriteReason, number> }> {
  const { rows } = await pool.query<ReviewedPlaceRow>(
    `SELECT p.id::text AS id, p.name,
            -- Снятое с карточки описание-дневник (1247) — тот текст, по
            -- которому заметку писали: судим заметку по нему.
            COALESCE(p.description, p.description_withdrawn) AS description,
            p.kuzmich_review,
            lsp.hazard_types, lsp.profile_source, lsp.altitude_m
       FROM places p
       LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
      WHERE p.is_visible = TRUE
        AND p.merged_into_id IS NULL
        AND p.kuzmich_review IS NOT NULL
        AND btrim(p.kuzmich_review) <> ''`,
  );

  const reasons: Record<RewriteReason, number> = { evidence: 0, diary_description: 0 };
  const ids: string[] = [];
  const texts: string[] = [];
  for (const r of rows) {
    // Те же данные, что видит агент при записи: описание и произносимый профиль.
    const honest = honestSafetyFields({
      hazardTypes: r.hazard_types ?? [],
      capacityPerDay: null,
      optimalGroupSize: null,
      difficultyLevel: null,
      terrainType: null,
    }, asProfileSource(r.profile_source));
    const reason = reviewRewriteReason(r.kuzmich_review, {
      description: r.description,
      hazardCodes: honest.hazardTypes,
      altitudeM: r.altitude_m,
    });
    if (reason === null) continue;
    reasons[reason]++;
    ids.push(r.id);
    texts.push(r.kuzmich_review);
  }
  if (ids.length === 0) return { checked: rows.length, reset: 0, reasons };

  const { rowCount } = await pool.query(
    `UPDATE places p
        SET kuzmich_review = NULL, updated_at = NOW()
       FROM unnest($1::text[], $2::text[]) AS s(id, review)
      WHERE p.id::text = s.id
        AND p.kuzmich_review = s.review`,
    [ids, texts],
  );
  return { checked: rows.length, reset: rowCount ?? 0, reasons };
}

interface PlaceRow {
  id: string;
  name: string;
  location_type: string | null;
  description: string | null;
  zone: string | null;
  lat: number;
  lng: number;
  altitude_m: number | null;
  difficulty_level: string | null;
  hazard_types: string[] | null;
  nearest_medical_km: number | null;
  terrain_type: string | null;
  profile_source: string | null;
}


async function loadPlacesNeedingReview(limit: number): Promise<PlaceRow[]> {
  const { rows } = await pool.query<PlaceRow>(
    `SELECT
       p.id,
       p.name,
       p.location_type,
       p.description,
       p.zone,
       p.lat,
       p.lng,
       lsp.altitude_m,
       lsp.difficulty_level,
       lsp.hazard_types,
       lsp.nearest_medical_km,
       lsp.terrain_type,
       lsp.profile_source
     FROM places p
     LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
     WHERE p.kuzmich_review IS NULL
       AND p.is_visible = true
       AND p.description IS NOT NULL
       AND LENGTH(p.description) >= 100
     ORDER BY RANDOM()
     LIMIT $1`,
    [limit],
  );
  return rows;
}

async function scrapeAdditionalContext(place: PlaceRow): Promise<string | null> {
  const query = encodeURIComponent(`${place.name} Камчатка`);
  const url = `https://2gis.ru/search/${query}`;
  const html = await fetchViaBrightData(url, { timeoutMs: 15_000 });
  if (!html) return null;

  // Очень простой экстракт: ищем текстовые блоки с описанием
  const textMatch = html.match(/<meta[^>]+name="description"[^>]+content="([^"]{50,300})"/i);
  return textMatch?.[1] ?? null;
}

async function generateKuzmichReview(place: PlaceRow, extraContext: string | null): Promise<string | null> {
  const typeLabel = place.location_type
    ? locationTypeLabelLower(place.location_type)
    : 'место';

  // Опасности и сложность — только если профиль не шаблон по типу места
  // (03.10). Никольская сопка числилась вулканом, промпт получил шаблонные
  // «avalanche, rockfall, thermal, altitude», и модель честно пересказала их:
  // «сход лавин, камнепады, жар» на городском холме. Запрет выдумки в
  // промпте бессилен, когда ложь приходит во входных данных.
  const honest = honestSafetyFields({
    hazardTypes: place.hazard_types ?? [],
    capacityPerDay: null,
    optimalGroupSize: null,
    difficultyLevel: place.difficulty_level === null ? null : Number(place.difficulty_level),
    terrainType: place.terrain_type,
  }, asProfileSource(place.profile_source));

  const safetyParts: string[] = [];
  if (place.altitude_m) safetyParts.push(`высота ${place.altitude_m}м`);
  if (honest.difficultyLevel !== null) safetyParts.push(`сложность: ${place.difficulty_level}`);
  if (honest.hazardTypes.length) safetyParts.push(`опасности: ${honest.hazardTypes.join(', ')}`);
  if (place.nearest_medical_km) safetyParts.push(`до медпомощи ${place.nearest_medical_km}км`);

  const safetyLine = safetyParts.length ? `\nБезопасность: ${safetyParts.join('; ')}` : '';
  const extraLine = extraContext ? `\nДополнительно: ${extraContext}` : '';

  const descSnippet = (place.description ?? '').slice(0, 600);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты — Кузьмич, голос опытного камчатского проводника на платформе TourHab. Пишешь короткую личную заметку о месте. Главная цель платформы — безопасность туристов, поэтому в заметке не должно быть ни одного выдуманного факта.

Жёсткие правила (нарушение недопустимо):
- Опирайся ТОЛЬКО на переданные данные: тип места, зону, блок "Безопасность" и описание. Своего реального опыта у тебя нет — не сочиняй "я был там", даты визитов, погоду или встречи с животными.
- Любое утверждение о безопасности (ледоруб, лавины, брод, активность вулкана, медведи, туман) пиши ТОЛЬКО если оно прямо есть в блоке "Безопасность" или в описании. Нет данных об опасности — не упоминай её и не придумывай.
- НЕ выдумывай числа (высоту, температуру, расстояния, сезон), которых нет в данных.
- Совет по снаряжению давай только если он логично вытекает из переданных опасностей. Для спокойного озера или пляжа не советуй альпинистское снаряжение.

Тон и формат:
- Говори как знающий местный: ёмко, с характером, но без выдумки.
- 1–2 предложения, максимум 280 символов, на русском.
- Без рекламных штампов ("захватывающий", "незабываемый", "уникальный"), без emoji, без markdown, без заголовков.

Калибровка по типу: для вулкана/высокогорья с переданными опасностями — акцент на серьёзности и подготовке; для озера/источника/пляжа без переданных опасностей — говори о характере места, не нагнетай выдуманную угрозу.`,
    },
    {
      role: 'user',
      content: `Место: ${place.name} (${typeLabel})${placeZoneLabel(place.zone) ? ', ' + placeZoneLabel(place.zone) : ''}${safetyLine}${extraLine}

Описание (единственный источник фактов вместе с блоком "Безопасность" выше; внешние данные могут быть неточными — не переноси из них конкретные числа и советы по безопасности):
${descSnippet}

Напиши заметку Кузьмича об этом месте, не добавляя ничего сверх переданных данных.`,
    },
  ];

  try {
    const result = await callAIWaterfall(messages);
    const trimmed = result?.trim();
    if (!trimmed || trimmed.length < 30) return null;
    // Отказ ВСЕХ провайдеров приходит СТРОКОЙ, а не исключением, и длиннее
    // тридцати символов: «Извините, сервис временно недоступен. Попробуйте
    // позже.» — пятьдесят четыре. Проверка одной длиной её пропускала, и
    // заглушка сохранялась туристу как заметка Кузьмича о месте (находка
    // аудита 08.09). Реестр заглушек на платформе один и требует, чтобы им
    // пользовались, — им и пользуемся.
    if (isWaterfallErrorResponse(trimmed)) {
      console.error('[kuzmich-place-enricher] заглушка водопада вместо заметки — не сохраняем');
      return null;
    }
    // Обрезаем до 400 символов на случай если AI переборщил
    return trimmed.length > 400 ? trimmed.slice(0, 397) + '...' : trimmed;
  } catch (err) {
    logSwallowedFailure('kuzmich-place-enricher', 'заметка о месте', err);
    return null;
  }
}

async function saveKuzmichReview(placeId: string, review: string): Promise<void> {
  await pool.query(
    `UPDATE places SET kuzmich_review = $1, updated_at = NOW() WHERE id = $2`,
    [review, placeId],
  );
}

export async function runKuzmichPlaceEnricher(batchSize = 20): Promise<KuzmichPlaceEnricherResult> {
  const start = Date.now();
  let enriched = 0, skipped = 0, rejected = 0, errors = 0;

  // Сначала — стоящие заметки: не прошедшие проверку уходят в очередь ниже.
  let reset = 0;
  let recheckFailed = false;
  try {
    const recheck = await recheckExistingReviews();
    reset = recheck.reset;
    if (reset > 0) {
      console.warn('[kuzmich-place-enricher] заметки сверх данных места сняты на перезапись', {
        checked: recheck.checked, reset, reasons: recheck.reasons,
      });
    }
  } catch (err) {
    recheckFailed = true;
    logSwallowedFailure('kuzmich-place-enricher', 'перепроверка стоящих заметок', err);
  }

  // Слово владельца 22.10: модель тексты мест не пишет. Перепроверка выше
  // осталась — она не сочиняет, а снимает сказанное сверх данных места, и
  // снятое теперь не переписывается моделью заново.
  if (!MODEL_WRITES_PLACE_TEXT) {
    return {
      processed: 0, enriched: 0, skipped: 0, rejected: 0, errors: 0,
      reset, recheck_failed: recheckFailed, paused: true,
      duration_ms: Date.now() - start,
    };
  }

  // Описание-дневник — не источник фактов: заметка пересказала бы выдумку.
  // Такие места отсеиваются ДО партии, а не внутри неё: выбор случайный, и
  // при сотне дневников без заметки они съедали бы большую часть из двадцати.
  const places = (await loadPlacesNeedingReview(batchSize * 5))
    .filter((p) => descriptionVoice(p.description).voice !== 'diary')
    .slice(0, batchSize);

  for (const place of places) {
    try {
      const extraContext = await scrapeAdditionalContext(place);
      const review = await generateKuzmichReview(place, extraContext);

      if (!review) {
        skipped++;
        continue;
      }

      // Те же данные, что получила модель: описание и произносимый профиль.
      const honest = honestSafetyFields({
        hazardTypes: place.hazard_types ?? [],
        capacityPerDay: null,
        optimalGroupSize: null,
        difficultyLevel: null,
        terrainType: null,
      }, asProfileSource(place.profile_source));
      const verdict = reviewClaims(review, {
        description: place.description,
        hazardCodes: honest.hazardTypes,
        altitudeM: place.altitude_m,
      });
      if (verdict.flags.length > 0) {
        rejected++;
        console.warn('[kuzmich-place-enricher] заметка не сохранена — сказано сверх данных места', {
          place: place.name,
          flags: verdict.flags,
          numbers: verdict.numbers,
          hazards: verdict.hazards,
        });
        continue;
      }

      await saveKuzmichReview(place.id, review);
      enriched++;
    } catch (err) {
      errors++;
      logSwallowedFailure('kuzmich-place-enricher', `заметка о месте «${place.name}»`, err);
    }

    // Пауза между запросами чтобы не перегружать AI
    await new Promise(r => setTimeout(r, 500));
  }

  return {
    processed: places.length,
    enriched,
    skipped,
    rejected,
    errors,
    reset,
    recheck_failed: recheckFailed,
    paused: false,
    duration_ms: Date.now() - start,
  };
}
