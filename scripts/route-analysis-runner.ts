/**
 * scripts/route-analysis-runner.ts — разбор ВСЕГО справочника маршрутов
 * одним проходом, с раннера.
 *
 * ── Зачем один проход ──────────────────────────────────────────────────────
 *
 * Переписи смотрят на маршруты по одному и отвечают на заранее заданный
 * вопрос. То, что видно только МЕЖДУ записями, ни одна из них не увидит:
 * одинаковый набор точек у двух маршрутов, имя без объекта, тёзки за 600 км,
 * точки соседнего маршрута. Модель с контекстом на миллион держит корпус
 * целиком и потому может это заметить.
 *
 * ── Почему находке можно верить ────────────────────────────────────────────
 *
 * Нельзя — на слово. Поэтому находки проверяются ДЕТЕРМИНИРОВАННО, тем же
 * приёмом, что `finding-guard` держит для Growth Scan:
 *
 *   — находка обязана ссылаться на id маршрутов ИЗ ВЫДАННЫХ ДАННЫХ;
 *   — id, которого в корпусе нет, — признак выдумки: находка выбрасывается
 *     и считается отдельно, чтобы выдумки было видно числом;
 *   — заголовки в находке сверяются с корпусом по id, а не берутся из
 *     ответа модели: пересказанное название могло быть переписано на ходу.
 *
 * Разбор ничего не пишет в базу. Он печатает находки, а решает человек:
 * переименование и разметка связей сочиняют смысл, и это не работа автомата
 * (§13, решение владельца про партии по 10).
 *
 * Использование: npx tsx scripts/route-analysis-runner.ts <corpus.json> [модель]
 */
import { readFileSync } from 'node:fs';

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-6-astra';
const RUB_PER_USD = 135; // §8

interface Route {
  id: string; title: string;
  description_head: string | null; description_len: number;
  zone: string | null; activity_type: string | null; season: string | null;
  route_type: string | null; distance_km: number | null;
  elevation_gain_m: number | null; duration_hours: number | null;
  lat: number | null; lng: number | null;
  geometry_source: string; geometry_points: number | null;
  hazards: string[]; equipment: string[]; park_name: string | null;
  waypoints: string[]; nearby: string[];
}

interface Corpus { total: number; summary: Record<string, number>; routes: Route[] }

interface Finding {
  kind?: string;
  route_ids?: string[];
  what?: string;
  evidence?: string;
  proposal?: string;
}

const SYSTEM = `Ты разбираешь справочник туристических маршрутов Камчатки для платформы, у которой главная задача — безопасность туристов.

Тебе выдан ВЕСЬ живой справочник целиком. Твоя работа — найти то, что видно только при взгляде на корпус СРАЗУ, а не на запись по отдельности.

Что искать (по убыванию важности):
1. Две и более записи, описывающие один и тот же путь (дубли под разными именами).
2. Маршруты с одинаковым или почти одинаковым набором путевых точек — признак, что точки раздавались по близости к центру, а не по прохождению.
3. Имя обещает объект, которого нет ни в путевых точках, ни в описании, ни среди соседей по координате.
4. Путевые точки, не подходящие маршруту: удалённые от его координаты, из другого района, явно чужие.
5. Факты, противоречащие друг другу внутри записи: дистанция против длительности, набор высоты против типа, сезон против активности.

ЖЁСТКИЕ ПРАВИЛА (нарушение делает находку бесполезной):
- Ссылайся ТОЛЬКО на id из выданных данных. Не сочиняй id.
- В поле evidence приводи ДОСЛОВНО те значения из данных, на которых основан вывод. Если привести нечего — находки нет.
- Не додумывай географию Камчатки по своим знаниям: судить можно только по выданным полям. Отсутствие поля — это «не знаю», а не повод предположить.
- Лучше десять находок с уликами, чем сто догадок.

Ответь СТРОГО одним JSON-объектом без пояснений вокруг:
{"findings":[{"kind":"duplicate|same_waypoints|title_without_object|foreign_waypoint|contradiction","route_ids":["..."],"what":"суть одной фразой","evidence":"дословные значения из данных","proposal":"что предлагаешь сделать"}]}`;

function parseFindings(raw: string): { findings: Finding[]; error: string | null } {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { findings: [], error: 'в ответе нет JSON-объекта' };
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as { findings?: unknown };
    if (!Array.isArray(parsed.findings)) return { findings: [], error: 'в ответе нет массива findings' };
    return { findings: parsed.findings as Finding[], error: null };
  } catch (err) {
    return { findings: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error('OPENROUTER_API_KEY не задан — спросить некого.'); process.exit(1); }

  const corpusPath = process.argv[2];
  const model = process.argv[3] || DEFAULT_MODEL;
  if (!corpusPath) { console.error('Не назван файл корпуса.'); process.exit(1); }

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as Corpus;
  const routes = corpus.routes ?? [];
  if (routes.length === 0) {
    // Ноль на входе — отказ, а не «разобрано чисто» (§4.0).
    console.error('Корпус пуст — разбирать нечего. Это отказ, а не «нарушений нет».');
    process.exit(1);
  }
  const byId = new Map(routes.map((r) => [r.id, r]));

  console.log(`корпус: ${routes.length} маршрутов`);
  console.log(`  без линии ${corpus.summary?.without_geometry ?? '?'} · без путевых точек ${corpus.summary?.without_waypoints ?? '?'}`
    + ` · без координат ${corpus.summary?.without_coords ?? '?'} · без описания ${corpus.summary?.without_description ?? '?'}`);
  console.log(`модель: ${model}`);

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(OPENROUTER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://vedarai.ru',
        'X-Title': 'TourHab route corpus analysis (runner)',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify(routes) },
        ],
        max_tokens: 8000,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(600_000),
    });
  } catch (err) {
    console.error('Модель не ответила:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const ms = Date.now() - started;

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    process.exit(1);
  }
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? null;
  const inTok = data.usage?.prompt_tokens ?? null;
  const outTok = data.usage?.completion_tokens ?? null;
  console.log(`ответ за ${(ms / 1000).toFixed(1)} с, токенов: вход ${inTok ?? '?'} / выход ${outTok ?? '?'}`);

  if (!text) { console.error('Ответ без содержимого.'); process.exit(1); }

  const { findings, error } = parseFindings(text);
  if (error) {
    console.error('Разбор ответа не удался:', error);
    console.error('--- начало ответа ---');
    console.error(text.slice(0, 1200));
    process.exit(1);
  }

  // Детерминированная проверка: id, которого в корпусе нет, — выдумка.
  const good: Array<Finding & { routes: Route[] }> = [];
  let invented = 0;
  for (const f of findings) {
    const ids = Array.isArray(f.route_ids) ? f.route_ids : [];
    const known = ids.filter((id) => byId.has(id));
    if (known.length === 0 || known.length !== ids.length) { invented += 1; continue; }
    good.push({ ...f, routes: known.map((id) => byId.get(id) as Route) });
  }

  console.log(`\nнаходок: ${good.length} принято, ${invented} выброшено (ссылки на маршруты вне корпуса)\n`);
  for (const f of good) {
    console.log('---');
    console.log(` род: ${f.kind ?? 'не назван'}`);
    // Заголовки берутся ИЗ КОРПУСА по id, а не из ответа: пересказанное
    // моделью имя могло быть переписано на ходу.
    for (const r of f.routes) console.log(`   • ${r.title}  [${r.id}]`);
    console.log(` суть: ${f.what ?? '(не сказано)'}`);
    console.log(` улика: ${f.evidence ?? '(не приведена)'}`);
    console.log(` предложение: ${f.proposal ?? '(нет)'}`);
  }

  if (inTok !== null && outTok !== null) {
    console.log(`\nтокенов вход ${inTok} / выход ${outTok}`);
  }
  if (good.length === 0) {
    console.error('\nНи одной находки с уликой. Это может значить и «корпус чист», и «модель не справилась» —'
      + ' различить нельзя, поэтому прогон красный, а не «всё хорошо».');
    process.exit(1);
  }
  console.log('\nНаходки НЕ записаны никуда: переименование и разметка связей сочиняют смысл — решает человек.');
}

void main();
