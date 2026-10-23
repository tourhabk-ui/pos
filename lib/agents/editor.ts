/**
 * lib/agents/editor.ts
 *
 * Editor — AI-редактор описаний маршрутов.
 * Запускается раз в сутки через /api/cron/editor.
 *
 * Источник: agent_route_knowledge (1386 маршрутов Камчатки).
 * Критерий: description IS NULL или LENGTH(description) < 300.
 * Действие: генерирует описание через AI → UPDATE agent_route_knowledge.
 * Лимит: 15 маршрутов за запуск.
 *
 * Места с 22.10 не пишет — слово владельца, выключатель
 * lib/places/model-place-text.ts (`editorKindSql` ниже).
 *
 * Ужесточён 23.10 (владелец: «Editor много выдумал его ужесточить промтном»):
 *   · промпт — пересказ записанных фактов и ничего сверх: без выводов, советов,
 *     оценок и описаний того, чего в фактах нет; мало фактов — короткий текст,
 *     совсем нечего сказать — ответ «НЕТ», и запись не пишется;
 *   · один ответ при низкой температуре вместо трёх вариантов с выбором
 *     НАИМЕНЕЕ типичного: для справочного текста наименее типичный — это
 *     самый сочинённый;
 *   · очередь — пустые описания и только СОБСТВЕННЫЕ короткие тексты модели
 *     (журнал 911). Короткий текст из источника, миграции или от человека
 *     Editor не переписывает и источником не берёт: дописать его можно только
 *     выдумкой (случай Микижи 27.09, теперь правилом для всех);
 *   · прежний текст модели не источник фактов ни для промпта, ни для проверки
 *     правды: иначе выдумка прошлого прогона узаконивала бы следующую;
 *   · факты — русскими подписями, а не кодами (`volcano`, `avalanche`):
 *     модель пересказывает слова источника, а не переводит их сама;
 *   · проверка правды сверяет и содержательные слова (`editor-truth-gate`).
 */

import { pool } from '@/lib/db-pool';
import { notOwnerDecidedSql } from '@/lib/places/owner-decided';
import { callAIQualityOrNull, isWaterfallErrorResponse } from '@/lib/ai/providers';
import type { AgentBriefing } from '@/lib/agents/warmup';
import type { ChatMessage } from '@/lib/ai/prompts';
import { parseVerbalizedSamples, looksLikeVerbalizedJson } from '@/lib/ai/verbalized-sampling';
import { sanitizeGarbageDescriptions } from '@/lib/agents/evo/content-sanitizer';
import { judgeGeneratedDescription } from '@/lib/agents/editor-truth-gate';
import { placeZoneLabel, routeDifficultyLabel, routeSeasonLabel, routeTypeLabel } from '@/lib/places/zone-labels';
import { locationTypeLabelLower } from '@/lib/places/location-types';
import { hazardLabel } from '@/lib/safety/hazard-labels';
import { ACTIVITY_LABELS } from '@/lib/tours/labels';
import { descriptionWrittenByModelSql } from '@/lib/places/description-by-model';
import { MODEL_WRITES_PLACE_TEXT } from '@/lib/places/model-place-text';

// A/B эксперимент 'editor-fugu-vs-waterfall' завершён 05.07.2026: НИЧЬЯ
// (Waterfall 36/36, Fugu 24/24 — оба 100%). При равном качестве выбран
// waterfall: бесплатные fast-провайдеры против платной оркестрации Fugu
// (~1260 токенов оверхеда на запрос). Решение владельца 04.07.2026:
// «фугу нам не нужно, опенроут дешевле». callFugu остаётся в providers.ts
// для ручной проверки (/api/admin/test-fugu) и health-пробы.

export interface EditorResult {
  processed: number;
  improved: number;
  improved_titles: string[];
  improved_ids: string[];  // ark_id / route.id — для smoke test по конкретным строкам
  errors: number;
  /** true, если цикл остановлен по бюджету времени (не все маршруты обработаны — остаток доберёт следующий прогон) */
  stopped_early: boolean;
  /** Раздельные счётчики: без них "30 ошибок" неотличимо — AI не ответил или БД не приняла запись */
  generation_failed: number;
  db_update_failed: number;
  /** Первые ~5 уникальных причин ошибок — уходят в Telegram-алерт смоук-теста вместо догадок */
  error_samples: string[];
  /** Ступень 4: сколько описаний-мусора система откатила (NULL) на этом прогоне для чистой регенерации */
  sanitized: number;
  /**
   * Сколько записей не пошли в модель, потому что писать не из чего: в базе
   * только название. Это НЕ ошибка и не провал — это очередь на данные.
   * Отдельным числом, чтобы «Editor ничего не сделал» перестало означать
   * сразу и «модель молчит», и «фактов нет»: лечится это разными вещами.
   */
  no_source: number;
  /**
   * Сколько текстов модели НЕ записано, потому что не прошли проверку правды
   * (`editor-truth-gate`): числа или опасности не из источника, голос
   * путевой заметки, рекламные эпитеты. Не ошибка генерации — отказ записи.
   */
  truth_rejected: number;
  duration_ms: number;
}

const BATCH_SIZE = 30;
const MIN_DESCRIPTION_LENGTH = 300;

// Бюджет времени на цикл генерации. Крон дёргает эндпоинт curl'ом с
// --max-time 300: если 30 последовательных AI-вызовов не уложатся, curl
// убивает запрос (exit 28) и весь прогон засчитывается как провал, хотя
// часть описаний уже записана. Особенно опасно в окно деплоя Timeweb, когда
// сервер холодный и первые вызовы медленные. Останавливаемся заранее и
// возвращаем частичный результат (200) — остаток доберёт следующий ночной
// прогон. Здоровый прогон 30 маршрутов укладывается сильно раньше бюджета,
// так что на него это не влияет. Оставляем запас ~90с эндпоинту на
// smoke-test + логирование + ответ до 300с-порога curl.
const TIME_BUDGET_MS = 210_000;

// «Отдых» перед повторной попыткой для уже обработанных коротких описаний.
// Причина (фидбэк владельца 07.2026): часть обскурных маршрутов честно
// получает короткий ответ (<300) — промпт прямо разрешает «честный короткий
// ответ, а не выдумку». Раньше такие строки < 300 переселялись КАЖДЫЙ прогон,
// бесконечно тратя AI-вызовы и вытесняя маршруты вообще без описания. Теперь
// после нашей записи маршрут «отдыхает» 7 дней (updated_at свежий) — за это
// время могут появиться реальные данные/лучшая модель. NULL-описания в приоритете.
const REATTEMPT_REST_DAYS = 7;

async function tgSend(text: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* silent */ }
}

export interface RouteRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  /**
   * Ниже — факты, которые база держала всё это время, а Editor не спрашивал.
   * Владелец 23.08: «не сверяется с фактами о месте, часто сочиняет». Причина
   * была не в модели: запрос брал четыре поля, а промпт требовал сто двадцать
   * слов. Просить объём, не дав источника, — заказ на выдумку (§4.0).
   */
  kind: string | null;            // 'place' | 'route' — из VIEW
  lat: number | null;
  lng: number | null;
  location_type: string | null;
  activity_type: string | null;
  zone: string | null;
  source_name: string | null;
  // Профиль безопасности точки (location_safety_profile по ark_id)
  altitude_m: number | null;
  terrain_type: string | null;
  hazard_types: string[] | null;
  difficulty_level: string | null;
  nearest_medical_km: number | null;
  // Паспорт маршрута (kamchatka_routes)
  distance_km: number | null;
  elevation_gain_m: number | null;
  duration_hours: number | null;
  season: string | null;
  route_type: string | null;
  hazards: string[] | null;
  equipment: string[] | null;
  park_name: string | null;
  /**
   * Точки пути маршрута по порядку (route_waypoints → places, без «рядом»),
   * с выдержкой из описания каждой. Аудит 02.10: 131 маршрут короче 100
   * слов, а Editor не давал модели ни одной точки пути — при том что у ~150
   * маршрутов они размечены и у мест есть свои описания. Это источник, а не
   * просьба «написать подлиннее»: длина по-прежнему следует за фактами.
   */
  waypoints?: Array<{ name: string; excerpt: string | null }> | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  vulkani:              'вулкан',
  termalnye_istochniki: 'термальные источники',
  geyzery:              'гейзеры',
  eco:                  'экотуризм',
  trekking:             'треккинг',
  lakes:                'озёра',
  rivers:               'реки',
  mountains:            'горы',
  rybalka:              'рыбалка',
  morskie_progulki:     'морские прогулки',
  vertoletnye_tury:     'вертолётные туры',
  medvedi:              'наблюдение за медведями',
  ekskursii:            'экскурсии',
  dzhip:                'джип-туры',
  ozera:                'озёра',
};

/**
 * Факты для промпта — только те, что ЕСТЬ. Отсутствующее не упоминается вовсе:
 * строка «высота: неизвестно» — это приглашение придумать высоту.
 */
export function buildFacts(route: RouteRow): string[] {
  const f: string[] = [];
  const put = (label: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) { if (v.length) f.push(`${label}: ${v.join(', ')}`); return; }
    f.push(`${label}: ${String(v)}`);
  };
  put('род записи', route.kind === 'place' ? 'точка на карте' : route.kind === 'route' ? 'маршрут' : null);
  put('категория', route.category ? (CATEGORY_LABELS[route.category] ?? route.category) : null);
  put('тип объекта', route.location_type ? locationTypeLabelLower(route.location_type) : null);
  put('вид активности', route.activity_type ? (ACTIVITY_LABELS[route.activity_type] ?? route.activity_type) : null);
  put('зона', placeZoneLabel(route.zone));
  if (route.lat !== null && route.lng !== null) f.push(`координаты: ${route.lat}, ${route.lng}`);
  put('высота над уровнем моря, м', route.altitude_m);
  put('рельеф', route.terrain_type);
  put('опасности точки', route.hazard_types?.map(hazardLabel) ?? null);
  put('сложность', route.difficulty_level ? (routeDifficultyLabel(route.difficulty_level) ?? route.difficulty_level) : null);
  put('до ближайшей медпомощи, км', route.nearest_medical_km);
  put('дистанция маршрута, км', route.distance_km);
  put('набор высоты, м', route.elevation_gain_m);
  put('длительность, ч', route.duration_hours);
  put('сезон', route.season ? (routeSeasonLabel(route.season) ?? route.season) : null);
  put('тип маршрута', route.route_type ? (routeTypeLabel(route.route_type) ?? route.route_type) : null);
  put('опасности маршрута', route.hazards?.map(hazardLabel) ?? null);
  put('снаряжение', route.equipment);
  // Не «природный парк» (14.10): park_name бывает памятником природы
  // («Вачкажец») и заповедником, а Editor пишет то, что ему назвали.
  put('охраняемая территория', route.park_name);
  put('источник данных', route.source_name);
  if (route.waypoints && route.waypoints.length > 0) {
    f.push(`точки маршрута по порядку: ${route.waypoints.map((w) => w.name).join(' → ')}`);
    for (const w of route.waypoints) {
      if (w.excerpt && w.excerpt.trim()) f.push(`о точке «${w.name}»: ${w.excerpt.trim()}`);
    }
  }
  return f;
}

/**
 * Экспорт с 07.09: тот же отбор нужен эндпоинту, который отдаёт работу
 * раннеру GitHub. Второй копии запроса быть не должно — иначе прод и раннер
 * писали бы описания разным записям.
 */
/**
 * Снятое описание — не дыра, которую заполняет модель (15.10).
 *
 * Дневники мест (1247) и описания маршрутов, написанные по одному названию
 * (1261), сняты с карточек в архивную колонку и ждут переписи ПО ИСТОЧНИКАМ.
 * Отбор Editor брал `description IS NULL` первым приоритетом и архива не
 * спрашивал: каждую ночь он заполнял бы снятое новым текстом модели, и место
 * выглядело бы переписанным. Тот же предикат, что у enrich-routes; строка
 * места в VIEW несёт places.ark_id, маршрута — COALESCE(ark_id, id).
 */
export function notWithdrawnSql(idExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM places w
                       WHERE w.ark_id = ${idExpr} AND w.description_withdrawn IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM kamchatka_routes wr
                       WHERE COALESCE(wr.ark_id, wr.id) = ${idExpr} AND wr.description_withdrawn IS NOT NULL)`;
}

/**
 * Места в очереди — только пока модели разрешено писать тексты мест.
 *
 * Слово владельца 22.10: «отключи агента выдумывающкюего описание мест такую
 * пургу придумал» (lib/places/model-place-text.ts). Очередь одна на прод и на
 * раннер: editor-job отдаёт её раннеру, editor-result по ней же сверяет
 * присланный id. Поэтому условие стоит здесь, а не в каждой двери: место,
 * которого нет в очереди, не пишется ни одной из них.
 */
export function editorKindSql(alias: string): string {
  return MODEL_WRITES_PLACE_TEXT ? 'TRUE' : `${alias}.kind IS DISTINCT FROM 'place'`;
}

/**
 * Условие очереди — одно на отбор и на счёт «в очереди» в отчёте: описания
 * нет, либо оно короткое, отдохнуло неделю и это СОБСТВЕННЫЙ текст модели
 * (последняя запись журнала 911 — писатель-модель, длина совпадает).
 *
 * До 23.10 очередь брала ЛЮБОЕ короткое описание, а прежний текст подавала
 * модели источником: короткий текст из паспорта, миграции или от человека
 * «дописывался» выдумкой (случай Микижи 27.09 закрыли только для текстов
 * владельца), а выдумка прошлого прогона становилась фактом следующего.
 * Теперь чужой короткий текст — ответ, а не недоработка, и Editor его не
 * трогает. `minParam` и `restParam` — номера параметров запроса.
 */
export function editorQueueWhereSql(alias: string, minParam: string, restParam: string): string {
  return `(${alias}.description IS NULL
       OR (LENGTH(${alias}.description) < ${minParam}
           AND ${alias}.updated_at < NOW() - make_interval(days => ${restParam})
           AND ${descriptionWrittenByModelSql(`${alias}.id`, `${alias}.description`)}
           -- Короткий текст по решению владельца — ответ, а не недоработка
           -- (lib/places/owner-decided.ts, случай Микижи 27.09).
           AND ${notOwnerDecidedSql(`${alias}.id`)}))
      AND ${notWithdrawnSql(`${alias}.id`)}
      AND ${editorKindSql(alias)}`;
}

export async function findRoutesNeedingDescription(): Promise<RouteRow[]> {
  // NULL-описания — всегда в приоритете (реальные пробелы важнее полировки).
  // Короткие — только свои, и только если их давно (>7 дней) никто не трогал
  // (см. REATTEMPT_REST_DAYS и editorQueueWhereSql).
  // Присоединяются ровно те источники, что описаны в §4.1: профиль
  // безопасности точки — по ark_id, паспорт маршрута — по kamchatka_routes.
  // VIEW сама отдаёт координаты, тип, зону, род и источник.
  const { rows } = await pool.query<RouteRow>(`
    SELECT
      ark.id, ark.title, ark.description, ark.category,
      ark.kind, ark.lat, ark.lng, ark.location_type, ark.activity_type,
      ark.zone, ark.source_name,
      lsp.altitude_m, lsp.terrain_type, lsp.hazard_types,
      lsp.difficulty_level, lsp.nearest_medical_km,
      kr.distance_km, kr.elevation_gain_m, kr.duration_hours,
      kr.season, kr.route_type, kr.hazards, kr.equipment, kr.park_name,
      -- Точки пути с выдержкой описания (до 400 знаков): источник для текста
      -- маршрута. «Рядом» не точка пути (§4.1), скрытые и слитые места — не
      -- источник. NULL, когда точек нет: отсутствующее не упоминается.
      (SELECT json_agg(json_build_object('name', p.name, 'excerpt', LEFT(p.description, 400)) ORDER BY rw.position)
         FROM route_waypoints rw
         JOIN places p ON p.id = rw.place_id
        WHERE kr.id IS NOT NULL AND rw.route_id = kr.id
          AND COALESCE(rw.link_kind, 'unknown') <> 'nearby'
          AND p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL) AS waypoints
    FROM agent_route_knowledge ark
    LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = ark.id
    LEFT JOIN kamchatka_routes        kr  ON kr.ark_id = ark.id
    WHERE ${editorQueueWhereSql('ark', '$1', '$3')}
    ORDER BY (ark.description IS NULL) DESC, RANDOM()
    LIMIT $2
  `, [MIN_DESCRIPTION_LENGTH, BATCH_SIZE, REATTEMPT_REST_DAYS]);
  return rows;
}

/**
 * Порог существует ради ОДНОГО: отсечь заглушку провайдера («Сервис временно
 * недоступен.» — 27 символов), а не ради объёма.
 *
 * До 23.08 он стоял на 100 и работал как квота: честный короткий ответ по двум
 * фактам считался ПРОВАЛОМ генерации, запись уходила в счётчик ошибок и
 * возвращалась на следующем прогоне — и так, пока модель не напишет подлиннее.
 * Подлиннее пишется только выдумкой. Наказывать за краткость там, где фактов
 * мало, значит требовать её восполнить.
 */
/** Порог длины описания. Экспорт — приёмник результата раннера судит им же. */
export const MIN_GENERATION_LENGTH = 40;

export interface GenerationOutcome {
  text: string | null;
  /** Причина провала (для error_samples) — только когда text непригоден */
  failReason?: string;
  /**
   * «Источника нет» — не ошибка. Запись, о которой в базе только название,
   * не должна попадать ни в модель, ни в счётчик отказов: она ждёт данных, а
   * не повторной попытки. Смешать её с провалом генерации значит потерять
   * из виду единственный вопрос, который здесь имеет смысл, — откуда взять
   * факты.
   */
  noSource?: boolean;
}

// Слишком короткий текст — почти всегда fallback-заглушка waterfall
// («Сервис временно недоступен.»), а не осмысленное описание.
function describeShortText(text: string | null): string {
  if (!text) return 'пустой ответ';
  return `короткий ответ ${text.length} симв. (вероятно fallback-заглушка — все fast-провайдеры отказали)`;
}

/**
 * Варианты системного промпта Editor — для held-out эксперимента.
 *
 * `full`  — действующий: блок «КРИТИЧНО — запрет на выдумывание» + стиль.
 * `lean`  — цель и формат без перечня запретов. Проверяем ходовое утверждение
 *           «умной модели длинные инструкции мешают»: держится ли качество,
 *           когда запреты убраны.
 *
 * Сравнивать варианты можно ТОЛЬКО двумя оракулами сразу (см.
 * lib/agents/eval/editor-regression.ts): по одной длине короткий вариант
 * заведомо выигрывает — без запретов модель пишет охотнее и длиннее, а растёт
 * при этом выдуманная конкретика, которой длина не видит.
 */
export type EditorPromptVariant = 'full' | 'lean';

const SYSTEM_LEAN = `Ты эксперт по туризму на Камчатке. Пишешь описания природных объектов и маршрутов для платформы Ведар, главная задача которой — безопасность туристов.

Стиль и формат:
- Фактически точный, спокойный, без рекламных штампов ("захватывающий", "незабываемый", "уникальный", "райский", "must-see").
- Без emoji, без markdown, без списков — связный текст, 2–3 абзаца, 200–350 слов, на русском.`;

/**
 * Сообщения для модели — ЧИСТАЯ функция от записи.
 *
 * Вынесена 07.09: описания теперь может писать не только прод, но и раннер
 * GitHub (OpenRouter с прода режется по сети — 403 и напрямую, и через релей).
 * Промпт обязан быть один: две копии разойдутся, и половина описаний окажется
 * написана по другим правилам, чем вторая.
 */
/**
 * Строгий промпт (23.10, владелец: «Editor много выдумал его ужесточить
 * промтном»). Принципы, а не перечень случаев (CLAUDE.md §8): каждое
 * предложение опирается на строку фактов; выводов, советов и оценок нет;
 * того, чего нет в фактах, нет и в тексте; нечего сказать — «НЕТ».
 *
 * Чего здесь больше нет и почему:
 *   · «Ты эксперт по туризму на Камчатке» — роль эксперта зовёт его знания, а
 *     своих знаний для этой работы у модели быть не должно;
 *   · «что из них следует для подготовки» — просьба о выводе, которого в
 *     данных нет: так появлялись «возьмите палки» и «подходит новичкам»;
 *   · прежнее описание «как источник» — в очередь попадает только текст
 *     самой модели, и выдумка прошлого прогона стала бы фактом этого;
 *   · три варианта с выбором наименее типичного — см. `pickDescriptionFromAnswer`.
 */
const SYSTEM_STRICT = `Ты редактор справочника Ведара — платформы, главная задача которой безопасность туристов на Камчатке. Твоя работа — пересказать связным текстом факты о маршруте или месте, записанные в базе. Своих знаний для этой работы у тебя нет: ни о Камчатке, ни о похожих местах.

Правила:
1. Каждое предложение опирается на строку из списка фактов. Если для утверждения нельзя показать строку-источник, его не пиши.
2. Не делай выводов из фактов: не советуй, что взять и как готовиться, не оценивай, кому подходит, насколько трудно или безопасно, чем интересно и как добраться, если этого нет в фактах.
3. Не описывай того, чего в фактах нет: природу, растительность, животных, погоду, виды, историю, дорогу, состояние тропы.
4. Числа, названия и опасности пиши только так, как они даны в фактах: без пересчёта и без новых.
5. Длина следует за фактами: два факта — одно-два предложения. Ничего не добавляй ради объёма: растянуть текст можно только выдумкой.
6. Если из фактов не складывается ни одного предложения сверх названия, ответь одним словом: НЕТ.

Форма: справочный тон, третье лицо, без впечатлений и рекламных слов, без списков, markdown и emoji, на русском.`;

/** Ответ «нечего написать» — разрешённый исход, а не провал. */
export const EDITOR_DECLINE_WORD = 'НЕТ';

/** Температура строгого пересказа: варианты подачи здесь не нужны. */
export const EDITOR_TEMPERATURE = 0.2;

export function buildDescriptionMessages(route: RouteRow, variant: EditorPromptVariant = 'full'): ChatMessage[] {
  const facts = buildFacts(route);
  return [
    { role: 'system', content: variant === 'lean' ? SYSTEM_LEAN : SYSTEM_STRICT },
    {
      role: 'user',
      content: `Название: ${route.title}

Факты из базы — весь твой источник:
${facts.map((f) => `- ${f}`).join('\n')}

Перескажи эти факты связным текстом по правилам. Ответь только текстом описания или словом ${EDITOR_DECLINE_WORD}.`,
    },
  ];
}

/**
 * Ответ модели → описание либо причина отказа. Тоже чистая и тоже общая:
 * Verbalized Sampling, выбор наименее шаблонного варианта и порог длины
 * применяются одинаково, кто бы ни звал модель.
 */
export function pickDescriptionFromAnswer(raw: string | null): GenerationOutcome {
  const text = (raw ?? '').trim() || null;
  if (!text) return { text: null, failReason: 'пустой ответ модели' };

  // Отказ ВСЕХ провайдеров приходит строкой, а не исключением. Судить о нём
  // длиной нельзя: «Извините, сервис временно недоступен. Попробуйте позже.»
  // — пятьдесят четыре символа при пороге сорок, то есть заглушка проходила
  // и сохранялась туристу как описание маршрута (находка аудита 08.09).
  // Реестр заглушек на платформе один (`isWaterfallErrorResponse`), и его
  // шапка прямо требует сверяться с ним; здесь этого не делали.
  if (isWaterfallErrorResponse(text)) {
    return { text: null, failReason: 'заглушка водопада: все провайдеры отказали' };
  }

  // «НЕТ» — модель сказала, что из фактов нечего написать. Это исход
  // «источника мало», а не провал генерации (§4.0, 23.10).
  if (text.replace(/[.!\s«»"]/g, '').toUpperCase() === EDITOR_DECLINE_WORD) {
    return { text: null, failReason: 'модель: из фактов нечего написать', noSource: true };
  }

  // Прежний промпт просил три варианта и брал НАИМЕНЕЕ вероятный — для
  // справочного текста это самый сочинённый (23.10). Теперь вариант один; если
  // модель всё же прислала массив вариантов, берётся САМЫЙ вероятный.
  const samples = parseVerbalizedSamples(text);
  const picked = samples.length > 0
    ? [...samples].sort((a, b) => b.probability - a.probability).find((x) => x.text.length >= MIN_GENERATION_LENGTH)?.text ?? null
    : null;
  const result = picked ?? (looksLikeVerbalizedJson(text) ? null : text);

  if (result && result.length >= MIN_GENERATION_LENGTH) return { text: result };
  return { text: null, failReason: `${result ? describeShortText(result) : 'битый VS-JSON — не сохранён'}` };
}

export async function generateRouteDescription(
  route: RouteRow,
  variant: EditorPromptVariant = 'full',
): Promise<GenerationOutcome> {
  // ТРЕТИЙ ИСХОД. Раньше их было два: «написал» и «провайдеры молчат». Записи,
  // о которых в базе нет ничего, кроме названия, всё равно уходили в модель —
  // и возвращались с текстом, взятым неоткуда. Теперь такая запись НЕ идёт в
  // модель вовсе: это не ошибка генерации, а честное «источника нет».
  // Заодно экономятся токены на самых бесполезных вызовах.
  // Прежний текст источником не считается (23.10): в очередь попадает только
  // собственный текст модели. Нет фактов — в модель не идём.
  const facts = buildFacts(route);
  if (facts.length === 0) {
    return { text: null, failReason: 'источника нет: в базе только название', noSource: true };
  }

  const messages = buildDescriptionMessages(route, variant);

  try {
    // callAIQualityOrNull даёт null, когда не ответил НИ ОДИН провайдер. Раньше сюда
    // приходила строка-заглушка «Сервис временно недоступен.», и отказ опознавали
    // ЭВРИСТИКОЙ по длине (27 симв.) — отсюда формулировка «вероятно заглушка».
    // Теперь причина известна точно, а не угадывается.
    // Описания читают туристы — это контент, а не структурный ответ. Поэтому
    // качественный путь (сильнейшая модель по очереди), а не гонка на скорость,
    // где побеждала мелкая быстрая модель.
    const answer = await callAIQualityOrNull(messages, { maxTokens: 1600, temperature: EDITOR_TEMPERATURE });
    if (answer === null) {
      return { text: null, failReason: 'все провайдеры отказали (DeepSeek/Qwen/waterfall) — ответа нет' };
    }
    // Разбор ответа — общий с раннером: Verbalized Sampling, выбор наименее
    // шаблонного варианта и порог длины одинаковы, кто бы ни звал модель.
    // Fallback на сырой ответ — ТОЛЬКО если это НЕ (битый) VS-JSON: иначе в
    // описание уехал бы сырой массив (реальный баг: «Озеро Большой Калыгирь»
    // показывало JSON [{probability,text},…]).
    return pickDescriptionFromAnswer(answer);
  } catch (err) {
    return { text: null, failReason: `exception: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runEditor(briefing?: AgentBriefing): Promise<EditorResult> {
  const start = Date.now();
  let processed = 0;
  let improved  = 0;
  let errors    = 0;
  let generationFailed = 0;
  let noSource = 0;
  let truthRejected = 0;
  let dbUpdateFailed   = 0;
  const errorSamples: string[] = [];
  const addErrorSample = (s: string) => {
    if (errorSamples.length < 5 && !errorSamples.includes(s)) errorSamples.push(s);
  };

  if (briefing?.platformSummary) {
    // Platform state is available — could be used for future smart prioritisation.
    // For now, presence of recentRuns lets us detect rapid re-runs (same day).
  }

  const improvedTitles: string[] = [];
  const improvedIds: string[] = [];

  // Ступень 4 — самокоррекция: перед регенерацией система откатывает (NULL)
  // описания-мусор из СВОИХ прошлых прогонов (сырой VS-JSON, отговорки модели,
  // заглушки). NULL сразу попадает в findRoutesNeedingDescription ниже и
  // переписывается чисто на этом же прогоне. Детерминированно, cap внутри.
  let sanitized = 0;
  try {
    const s = await sanitizeGarbageDescriptions();
    sanitized = s.cleared;
    if (sanitized > 0) {
      const reasons = Object.entries(s.byReason).map(([k, v]) => `${k}:${v}`).join(', ');
      addErrorSample(`санитар: откатил ${sanitized} описаний-мусора (${reasons}) → регенерация`);
    }
  } catch (err) {
    addErrorSample(`sanitize: ${err instanceof Error ? err.message : String(err)}`);
  }

  let routes: RouteRow[];
  try {
    routes = await findRoutesNeedingDescription();
  } catch (err) {
    return {
      processed: 0, improved: 0, improved_titles: [], improved_ids: [], errors: 1,
      stopped_early: false,
      generation_failed: 0, db_update_failed: 0, no_source: 0, truth_rejected: 0,
      error_samples: [`db_select: ${err instanceof Error ? err.message : String(err)}`],
      sanitized,
      duration_ms: Date.now() - start,
    };
  }

  let stoppedEarly = false;
  for (const route of routes) {
    // Не начинаем новый AI-вызов, если бюджет исчерпан — иначе рискуем не
    // вернуться до curl --max-time 300 (см. TIME_BUDGET_MS). Уже записанные
    // описания сохранены, остаток возьмёт следующий прогон.
    if (Date.now() - start > TIME_BUDGET_MS) {
      stoppedEarly = true;
      addErrorSample(`бюджет времени исчерпан (${TIME_BUDGET_MS / 1000}с) — обработано ${processed}/${routes.length}, остаток на следующий прогон`);
      break;
    }
    processed++;
    const { text: newDescription, failReason, noSource: lacksSource } =
      await generateRouteDescription(route);
    if (lacksSource) {
      // Не ошибка: писать не из чего. В модель запись не ходила.
      noSource++;
      continue;
    }
    if (!newDescription || newDescription.length < MIN_GENERATION_LENGTH) {
      errors++;
      generationFailed++;
      addErrorSample(failReason ?? 'генерация: причина неизвестна');
      continue;
    }
    // Проверка правды ДО записи (решение владельца 03.10). Не прошёл — текст
    // не пишется; прежнее описание остаётся, запись вернётся в очередь.
    // Прежний текст — собственный текст модели или пустота: источником для
    // проверки он не служит, иначе вчерашняя выдумка узаконила бы сегодняшнюю.
    const verdict = judgeGeneratedDescription(newDescription, {
      facts: buildFacts(route), title: route.title, previous: null,
    });
    if (!verdict.ok) {
      truthRejected++;
      addErrorSample(`не записано «${route.title}»: ${verdict.reasons.join('; ')}`);
      continue;
    }
    try {
      await pool.query(
        `UPDATE agent_route_knowledge SET description = $1 WHERE id = $2`,
        [newDescription, route.id],
      );
      // Происхождение — рядом с текстом, а не «когда-нибудь потом». Без этой
      // записи машинный текст неотличим от текста из источника: именно так и
      // вышло, что на вопрос «сколько описаний сочинено» ответить было нечем
      // (миграция 911). Отказ журнала не отменяет описание, но и не молчит.
      try {
        const facts = buildFacts(route);
        await pool.query(
          `INSERT INTO description_provenance
             (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
           VALUES ($1, $2, $3, 'editor-ai', $4::jsonb, $5, $6, $7)`,
          [route.id, route.kind ?? 'unknown', route.title,
           JSON.stringify(facts), facts.length,
           newDescription.length, route.description?.length ?? null],
        );
      } catch (err) {
        addErrorSample(`provenance «${route.title}»: ${err instanceof Error ? err.message : String(err)}`);
      }
      improved++;
      improvedTitles.push(route.title);
      improvedIds.push(route.id);
    } catch (err) {
      errors++;
      dbUpdateFailed++;
      addErrorSample(`db_update «${route.title}»: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (improved > 0 || sanitized > 0 || truthRejected > 0) {
    // Два числа вместо одного: queue — сколько Editor реально возьмёт на
    // следующих прогонах (NULL + короткие «отдохнувшие»); total_short — общий
    // разрыв качества, который плато на честно-неизвестных маршрутах (их
    // короткие описания правдивы, до 300 не растянуть без выдумки).
    let queue = -1;
    let totalShort = -1;
    try {
      const { rows } = await pool.query<{ queue: string; total_short: string }>(
        // Снятое в очередь не входит и в разрыв не считается: его пишут по
        // источникам люди, а не Editor.
        `SELECT
           COUNT(*) FILTER (WHERE ${editorQueueWhereSql('ark', '$1', '$2')})::text AS queue,
           COUNT(*) FILTER (WHERE ark.description IS NULL OR LENGTH(ark.description) < $1)::text AS total_short
         FROM agent_route_knowledge ark
        WHERE ${notWithdrawnSql('ark.id')}
          AND ${editorKindSql('ark')}`,
        [MIN_DESCRIPTION_LENGTH, REATTEMPT_REST_DAYS]
      );
      queue = Number(rows[0]?.queue ?? 0);
      totalShort = Number(rows[0]?.total_short ?? 0);
    } catch { /* оставляем -1 → «?» */ }

    const titlesList = improvedTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    await tgSend(
      `<b>Editor</b> — улучшил ${improved} описаний\n` +
      `(обработано: ${processed}, ошибок: ${errors})\n` +
      (sanitized > 0 ? `Санитар откатил мусор: ${sanitized} описаний → чистая регенерация\n` : '') +
      (truthRejected > 0 ? `Не записано по проверке правды: ${truthRejected}\n` : '') +
      (stoppedEarly ? `Остановлен по бюджету времени — остаток доберёт следующий прогон\n` : '') +
      `В очереди на обработку: ${queue >= 0 ? queue : '?'} · всего коротких: ${totalShort >= 0 ? totalShort : '?'}\n\n` +
      (titlesList ? `<b>Улучшенные маршруты и локации:</b>\n${titlesList}` : ''),
    );
  }

  return {
    processed, improved, improved_titles: improvedTitles, improved_ids: improvedIds, errors,
    stopped_early: stoppedEarly,
    generation_failed: generationFailed, db_update_failed: dbUpdateFailed,
    no_source: noSource,
    truth_rejected: truthRejected,
    error_samples: errorSamples,
    sanitized,
    duration_ms: Date.now() - start,
  };
}
