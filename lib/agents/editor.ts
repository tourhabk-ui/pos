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
import { callAIFast } from '@/lib/ai/providers';
import type { AgentBriefing } from '@/lib/agents/warmup';
import type { ChatMessage } from '@/lib/ai/prompts';
import { verbalizedInstruction, parseVerbalizedSamples, pickLeastTypical, looksLikeVerbalizedJson } from '@/lib/ai/verbalized-sampling';

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
}

async function findRoutesNeedingDescription(): Promise<RouteRow[]> {
  // NULL-описания — всегда в приоритете (реальные пробелы важнее полировки).
  // Короткие (<300) берём только если их давно (>7 дней) никто не трогал —
  // иначе честно-короткие ответы циклятся каждый прогон (см. REATTEMPT_REST_DAYS).
  const { rows } = await pool.query<RouteRow>(`
    SELECT id, title, description, category
    FROM agent_route_knowledge
    WHERE description IS NULL
       OR (LENGTH(description) < $1 AND updated_at < NOW() - make_interval(days => $3))
    ORDER BY (description IS NULL) DESC, RANDOM()
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

/** Минимальная длина сгенерированного текста, чтобы считать генерацию успешной. */
const MIN_GENERATION_LENGTH = 100;

export interface GenerationOutcome {
  text: string | null;
  /** Причина провала (для error_samples) — только когда text непригоден */
  failReason?: string;
}

// Слишком короткий текст — почти всегда fallback-заглушка waterfall
// («Сервис временно недоступен.»), а не осмысленное описание.
function describeShortText(text: string | null): string {
  if (!text) return 'пустой ответ';
  return `короткий ответ ${text.length} симв. (вероятно fallback-заглушка — все fast-провайдеры отказали)`;
}

export async function generateRouteDescription(route: RouteRow): Promise<GenerationOutcome> {
  const categoryLabel = route.category ? (CATEGORY_LABELS[route.category] ?? route.category) : '';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты эксперт по туризму на Камчатке. Пишешь описания природных объектов и маршрутов для платформы TourHab. Главная задача платформы — безопасность туристов, поэтому каждое слово должно быть либо проверяемым фактом, либо честным обобщением без выдуманной конкретики.

КРИТИЧНО — запрет на выдумывание:
- НЕ придумывай конкретные числа, которых тебе не дали: высоту, координаты, длину маршрута, перепад, температуру источника, расстояние до жилья, время в пути.
- НЕ выдумывай факты о безопасности: наличие/отсутствие бродов, лавин, камнепадов, активности вулкана, "безопасно для новичков". Неверный факт о безопасности может стоить туристу жизни.
- Если конкретных данных нет — пиши обобщённо и честно ("точные параметры уточняйте у оператора и в дирекции парка"), а не выдумывай правдоподобное число.
- Опирайся ТОЛЬКО на название, тип и переданное описание. Название — не основание сочинять детали.

Стиль и формат:
- Фактически точный, спокойный, без рекламных штампов ("захватывающий", "незабываемый", "уникальный", "райский", "must-see").
- Без emoji, без markdown, без списков — связный текст, 2–3 абзаца, 200–350 слов, на русском.`,
    },
    {
      role: 'user',
      content: `Напиши описание для туристического объекта Камчатки.
Название: ${route.title}
${categoryLabel ? `Тип: ${categoryLabel}` : 'Тип не указан — не угадывай его как факт.'}
${route.description ? `Имеющееся описание (бери из него факты, расширь и улучши, ничего не выдумывай сверх него): ${route.description}` : 'Готового описания нет — опирайся на название и тип и на свои общие знания о таком типе объектов Камчатки.'}

Дай СОДЕРЖАТЕЛЬНЫЙ обзор (2 абзаца, не меньше 120 слов): что это за место и его общий характер, чем интересно, на что обратить внимание при подготовке.
«Обобщённо» НЕ значит «кратко» — пиши полноценно про характер, ландшафт, общее впечатление.
Запрет касается только ВЫДУМАННОЙ КОНКРЕТИКИ: не указывай конкретные числа (высоту, координаты, расстояния, температуру) и факты о безопасности (опасности, сложность, броды), если их нет в переданных данных. Общее описание характера места — пиши.
Если про конкретно это место ты ничего достоверного не знаешь и название ничего не говорит — лучше дай честный короткий ответ, чем выдумку (такой маршрут получит описание позже из реальных источников).

${verbalizedInstruction(3)}
Каждый text — это готовое описание по правилам выше (те же запреты на выдуманную конкретику). Варианты должны отличаться подачей и акцентами, но все — фактически честные.`,
    },
  ];

  try {
    const raw = (await callAIFast(messages))?.trim() ?? null;
    if (!raw) return { text: null, failReason: `callAIFast: ${describeShortText(raw)}` };

    // Verbalized Sampling: берём наименее шаблонный валидный вариант из распределения.
    // Fallback на сырой ответ — ТОЛЬКО если это НЕ (битый) VS-JSON. Иначе рискуем
    // сохранить сырой обрезанный массив как описание (реальный баг на проде:
    // «Озеро Большой Калыгирь» показывало JSON [{probability,text},…]). Битый
    // VS-JSON = провал генерации → text:null, старое описание сохраняется.
    const samples = parseVerbalizedSamples(raw);
    const picked = pickLeastTypical(samples, MIN_GENERATION_LENGTH);
    const result = picked ?? (looksLikeVerbalizedJson(raw) ? null : raw);

    if (result && result.length >= MIN_GENERATION_LENGTH) return { text: result };
    return { text: null, failReason: `callAIFast: ${result ? describeShortText(result) : 'битый VS-JSON — не сохранён'}` };
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

  let routes: RouteRow[];
  try {
    routes = await findRoutesNeedingDescription();
  } catch (err) {
    return {
      processed: 0, improved: 0, improved_titles: [], improved_ids: [], errors: 1,
      stopped_early: false,
      generation_failed: 0, db_update_failed: 0,
      error_samples: [`db_select: ${err instanceof Error ? err.message : String(err)}`],
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
    const { text: newDescription, failReason } = await generateRouteDescription(route);
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
      improved++;
      improvedTitles.push(route.title);
      improvedIds.push(route.id);
    } catch (err) {
      errors++;
      dbUpdateFailed++;
      addErrorSample(`db_update «${route.title}»: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (improved > 0) {
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
      (stoppedEarly ? `Остановлен по бюджету времени — остаток доберёт следующий прогон\n` : '') +
      `В очереди на обработку: ${queue >= 0 ? queue : '?'} · всего коротких: ${totalShort >= 0 ? totalShort : '?'}\n\n` +
      `<b>Улучшенные маршруты и локации:</b>\n${titlesList}`,
    );
  }

  return {
    processed, improved, improved_titles: improvedTitles, improved_ids: improvedIds, errors,
    stopped_early: stoppedEarly,
    generation_failed: generationFailed, db_update_failed: dbUpdateFailed, error_samples: errorSamples,
    duration_ms: Date.now() - start,
  };
}
