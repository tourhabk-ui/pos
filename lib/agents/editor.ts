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
 */

import { pool } from '@/lib/db-pool';
import { callAIQualityOrNull } from '@/lib/ai/providers';
import type { AgentBriefing } from '@/lib/agents/warmup';
import type { ChatMessage } from '@/lib/ai/prompts';
import { verbalizedInstruction, parseVerbalizedSamples, pickLeastTypical, looksLikeVerbalizedJson } from '@/lib/ai/verbalized-sampling';
import { sanitizeGarbageDescriptions } from '@/lib/agents/evo/content-sanitizer';

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
}

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
  put('тип объекта', route.location_type);
  put('вид активности', route.activity_type);
  put('зона', route.zone);
  if (route.lat !== null && route.lng !== null) f.push(`координаты: ${route.lat}, ${route.lng}`);
  put('высота над уровнем моря, м', route.altitude_m);
  put('рельеф', route.terrain_type);
  put('опасности точки', route.hazard_types);
  put('сложность', route.difficulty_level);
  put('до ближайшей медпомощи, км', route.nearest_medical_km);
  put('дистанция маршрута, км', route.distance_km);
  put('набор высоты, м', route.elevation_gain_m);
  put('длительность, ч', route.duration_hours);
  put('сезон', route.season);
  put('тип маршрута', route.route_type);
  put('опасности маршрута', route.hazards);
  put('снаряжение', route.equipment);
  put('природный парк', route.park_name);
  put('источник данных', route.source_name);
  return f;
}

async function findRoutesNeedingDescription(): Promise<RouteRow[]> {
  // NULL-описания — всегда в приоритете (реальные пробелы важнее полировки).
  // Короткие (<300) берём только если их давно (>7 дней) никто не трогал —
  // иначе честно-короткие ответы циклятся каждый прогон (см. REATTEMPT_REST_DAYS).
  // Присоединяются ровно те источники, что описаны в §4.1: профиль
  // безопасности точки — по ark_id, паспорт маршрута — по kamchatka_routes.
  // VIEW сама отдаёт координаты, тип, зону, род и источник; их просто не
  // спрашивали.
  const { rows } = await pool.query<RouteRow>(`
    SELECT
      ark.id, ark.title, ark.description, ark.category,
      ark.kind, ark.lat, ark.lng, ark.location_type, ark.activity_type,
      ark.zone, ark.source_name,
      lsp.altitude_m, lsp.terrain_type, lsp.hazard_types,
      lsp.difficulty_level, lsp.nearest_medical_km,
      kr.distance_km, kr.elevation_gain_m, kr.duration_hours,
      kr.season, kr.route_type, kr.hazards, kr.equipment, kr.park_name
    FROM agent_route_knowledge ark
    LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = ark.id
    LEFT JOIN kamchatka_routes        kr  ON kr.ark_id = ark.id
    WHERE ark.description IS NULL
       OR (LENGTH(ark.description) < $1 AND ark.updated_at < NOW() - make_interval(days => $3))
    ORDER BY (ark.description IS NULL) DESC, RANDOM()
    LIMIT $2
  `, [MIN_DESCRIPTION_LENGTH, BATCH_SIZE, REATTEMPT_REST_DAYS]);
  return rows;
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
 * Порог существует ради ОДНОГО: отсечь заглушку провайдера («Сервис временно
 * недоступен.» — 27 символов), а не ради объёма.
 *
 * До 23.08 он стоял на 100 и работал как квота: честный короткий ответ по двум
 * фактам считался ПРОВАЛОМ генерации, запись уходила в счётчик ошибок и
 * возвращалась на следующем прогоне — и так, пока модель не напишет подлиннее.
 * Подлиннее пишется только выдумкой. Наказывать за краткость там, где фактов
 * мало, значит требовать её восполнить.
 */
const MIN_GENERATION_LENGTH = 40;

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

const SYSTEM_LEAN = `Ты эксперт по туризму на Камчатке. Пишешь описания природных объектов и маршрутов для платформы TourHab, главная задача которой — безопасность туристов.

Стиль и формат:
- Фактически точный, спокойный, без рекламных штампов ("захватывающий", "незабываемый", "уникальный", "райский", "must-see").
- Без emoji, без markdown, без списков — связный текст, 2–3 абзаца, 200–350 слов, на русском.`;

export async function generateRouteDescription(
  route: RouteRow,
  variant: EditorPromptVariant = 'full',
): Promise<GenerationOutcome> {
  const categoryLabel = route.category ? (CATEGORY_LABELS[route.category] ?? route.category) : '';

  // ТРЕТИЙ ИСХОД. Раньше их было два: «написал» и «провайдеры молчат». Записи,
  // о которых в базе нет ничего, кроме названия, всё равно уходили в модель —
  // и возвращались с текстом, взятым неоткуда. Теперь такая запись НЕ идёт в
  // модель вовсе: это не ошибка генерации, а честное «источника нет».
  // Заодно экономятся токены на самых бесполезных вызовах.
  const facts = buildFacts(route);
  if (facts.length === 0 && !route.description) {
    return { text: null, failReason: 'источника нет: в базе только название', noSource: true };
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: variant === 'lean' ? SYSTEM_LEAN : `Ты эксперт по туризму на Камчатке. Пишешь описания природных объектов и маршрутов для платформы TourHab. Главная задача платформы — безопасность туристов, поэтому каждое слово должно быть либо проверяемым фактом, либо честным обобщением без выдуманной конкретики.

КРИТИЧНО — пиши ТОЛЬКО из переданных фактов:
- Ниже тебе дан список фактов из базы. Это ВЕСЬ твой источник. Чего в списке нет — того не существует для тебя: не упоминай, не выводи, не додумывай.
- НЕ придумывай числа: высоту, координаты, длину, перепад, температуру, расстояния, время в пути.
- НЕ выдумывай факты о безопасности: броды, лавины, камнепады, активность вулкана, «безопасно для новичков». Неверный факт о безопасности может стоить туристу жизни.
- Своими общими знаниями о Камчатке пользоваться ЗАПРЕЩЕНО. Похожие места бывают разными, а турист пойдёт именно в это.

Длина следует за фактами, а не наоборот:
- Пять фактов — несколько предложений. Два факта — две строки. Это НОРМАЛЬНЫЙ ответ, а не плохой.
- Растягивать текст ради объёма запрещено: растянуть можно только выдумкой.

Стиль:
- Фактически точный, спокойный, без рекламных штампов («захватывающий», «незабываемый», «уникальный», «райский», «must-see»).
- Без emoji, без markdown, без списков — связный текст на русском.`,
    },
    {
      role: 'user',
      content: `Напиши описание для туристического объекта Камчатки.
Название: ${route.title}
${categoryLabel ? `Тип: ${categoryLabel}` : ''}

ФАКТЫ ИЗ БАЗЫ — это весь твой источник:
${facts.map((f) => `- ${f}`).join('\n')}
${route.description ? `\nИмеющееся описание (факты бери и из него): ${route.description}` : ''}

Напиши связный текст, опираясь ТОЛЬКО на перечисленное: что это за объект, что о нём известно из фактов, что из них следует для подготовки.
Длину определяют факты. Мало фактов — короткий текст, и это правильный ответ.
Ничего сверх списка не добавляй: ни характера местности, ни впечатлений, ни того, «чем обычно интересны такие места».

${verbalizedInstruction(3)}
Каждый text — это готовое описание по правилам выше (те же запреты на выдуманную конкретику). Варианты должны отличаться подачей и акцентами, но все — фактически честные.`,
    },
  ];

  try {
    // callAIQualityOrNull даёт null, когда не ответил НИ ОДИН провайдер. Раньше сюда
    // приходила строка-заглушка «Сервис временно недоступен.», и отказ опознавали
    // ЭВРИСТИКОЙ по длине (27 симв.) — отсюда формулировка «вероятно заглушка».
    // Теперь причина известна точно, а не угадывается.
    // Описания читают туристы — это контент, а не структурный ответ. Поэтому
    // качественный путь (сильнейшая модель по очереди), а не гонка на скорость,
    // где побеждала мелкая быстрая модель.
    const answer = await callAIQualityOrNull(messages, { maxTokens: 1600 });
    if (answer === null) {
      return { text: null, failReason: 'все провайдеры отказали (DeepSeek/Qwen/waterfall) — ответа нет' };
    }
    const raw = answer.trim() || null;
    if (!raw) return { text: null, failReason: 'пустой ответ модели' };

    // Verbalized Sampling: берём наименее шаблонный валидный вариант из распределения.
    // Fallback на сырой ответ — ТОЛЬКО если это НЕ (битый) VS-JSON. Иначе рискуем
    // сохранить сырой обрезанный массив как описание (реальный баг на проде:
    // «Озеро Большой Калыгирь» показывало JSON [{probability,text},…]). Битый
    // VS-JSON = провал генерации → text:null, старое описание сохраняется.
    const samples = parseVerbalizedSamples(raw);
    const picked = pickLeastTypical(samples, MIN_GENERATION_LENGTH);
    const result = picked ?? (looksLikeVerbalizedJson(raw) ? null : raw);

    if (result && result.length >= MIN_GENERATION_LENGTH) return { text: result };
    return { text: null, failReason: `${result ? describeShortText(result) : 'битый VS-JSON — не сохранён'}` };
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
      generation_failed: 0, db_update_failed: 0, no_source: 0,
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

  if (improved > 0 || sanitized > 0) {
    // Два числа вместо одного: queue — сколько Editor реально возьмёт на
    // следующих прогонах (NULL + короткие «отдохнувшие»); total_short — общий
    // разрыв качества, который плато на честно-неизвестных маршрутах (их
    // короткие описания правдивы, до 300 не растянуть без выдумки).
    let queue = -1;
    let totalShort = -1;
    try {
      const { rows } = await pool.query<{ queue: string; total_short: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE description IS NULL
             OR (LENGTH(description) < $1 AND updated_at < NOW() - make_interval(days => $2)))::text AS queue,
           COUNT(*) FILTER (WHERE description IS NULL OR LENGTH(description) < $1)::text AS total_short
         FROM agent_route_knowledge`,
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
    error_samples: errorSamples,
    sanitized,
    duration_ms: Date.now() - start,
  };
}
