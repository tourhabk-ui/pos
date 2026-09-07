/**
 * scripts/os-audit-runner.ts — аудит ОС и эволюции одним проходом.
 *
 * Владелец 08.09: «может Astra проведёт аудит ОС и эволюции, может мы тоже
 * упустили что-то».
 *
 * ── Почему это осмысленно ──────────────────────────────────────────────────
 *
 * Мы судим платформу по кусочкам: сторож проверяет своё, перепись считает
 * своё, ревью смотрит диф. Ни один из них не держит перед глазами ПРАВИЛА и
 * ИСПОЛНЕНИЕ одновременно, а расхождение между ними живёт именно там.
 *
 * За один сегодняшний день нашлось четыре таких расхождения, и ни одно не
 * поймал ни один сторож:
 *
 *   - `search_text` в представлении объявлен `NULL::tsvector` — поиск мест
 *     Кузьмича падал на каждом вызове, отказ глотал `catch`;
 *   - правило старшинства линии было скопировано в девять мест и разошлось;
 *   - ожидание выкладки отчитывалось успехом, не дождавшись;
 *   - сторож `track-import-queue-read` резал файл от исчезнувшей константы и
 *     молча проверял пустоту.
 *
 * Модель с контекстом на миллион читает правила, реализацию и сторожей
 * ЦЕЛИКОМ и может увидеть то, что видно только рядом.
 *
 * ── Почему находке можно верить ────────────────────────────────────────────
 *
 * Не на слово. Каждая обязана ссылаться на файл ИЗ ВЫДАННОГО НАБОРА; ссылка
 * на файл вне набора — признак выдумки: находка выбрасывается и считается
 * отдельным числом. Тот же приём, что у `finding-guard` и у разбора
 * маршрутов.
 *
 * Аудит ничего не меняет и ничего не решает: печатает находки, решает человек.
 *
 * Использование: npx tsx scripts/os-audit-runner.ts <модель> [<glob> ...]
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { salvageTruncatedArray } from '../lib/ai/json-salvage';
import { openRouterAttribution } from '../lib/ai/attribution';

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const RUB_PER_USD = 135; // §8
/** Потолок набора: миллионный контекст велик, но платим за каждый токен. */
const BUNDLE_LIMIT_BYTES = 1_800_000;

/** Что читаем по умолчанию: правила, исполнение, сторожа этих же агентов. */
const DEFAULT_TARGETS = [
  'CLAUDE.md',
  'AGENTS.md',
  'lib/agents',
  'lib/ai/providers.ts',
  'lib/ai/model-resolver.ts',
];
/** Сторожа берутся по имени: аудит про агентов, а не про весь репозиторий. */
const GUARD_PATTERN = /(cron|evo|watchdog|agent|scout|editor)/;

interface Bundled { path: string; text: string }

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (/\.(ts|tsx|md)$/.test(full)) out.push(full);
  }
}

function collect(targets: string[]): { files: Bundled[]; skipped: number; bytes: number } {
  const root = process.cwd();
  const paths: string[] = [];
  for (const t of targets) {
    const full = join(root, t);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, paths);
    else paths.push(full);
  }
  for (const f of readdirSync(join(root, 'tests/unit'))) {
    if (/\.test\.ts$/.test(f) && GUARD_PATTERN.test(f)) paths.push(join(root, 'tests/unit', f));
  }

  const files: Bundled[] = [];
  let bytes = 0;
  let skipped = 0;
  for (const p of paths.sort()) {
    const text = readFileSync(p, 'utf8');
    if (bytes + text.length > BUNDLE_LIMIT_BYTES) { skipped += 1; continue; }
    bytes += text.length;
    files.push({ path: relative(root, p), text });
  }
  return { files, skipped, bytes };
}

const SYSTEM = `Ты проводишь аудит платформы «Ведар» (туризм и безопасность на Камчатке) по её собственным исходникам.

Тебе выдан набор файлов: ПРАВИЛА платформы (CLAUDE.md, AGENTS.md), РЕАЛИЗАЦИЯ агентов и АВТОМАТИЧЕСКИЕ СТОРОЖА (tests/unit/*.test.ts).

Ищи расхождения, которые видны ТОЛЬКО при взгляде на всё сразу:

1. Правило записано в CLAUDE.md, но код его не исполняет (или исполняет иначе).
2. Одно правило реализовано в нескольких местах и копии разошлись между собой.
3. Сторож существует, но по факту ничего не проверяет: якорь съехал, срез пуст, условие всегда истинно.
4. Отказ проглатывается: пустой catch, \`return null\` без причины, «ошибка» неотличима от «данных нет».
5. Проверка с двумя исходами там, где нужен третий — «не смог проверить» (правило §4.0 «третьего состояния»).
6. Заявленное расписание или поведение агента не подтверждается кодом.

ЖЁСТКИЕ ПРАВИЛА (нарушение делает находку бесполезной):
- Ссылайся ТОЛЬКО на пути файлов из выданного набора. Не сочиняй путей.
- В evidence приводи ДОСЛОВНЫЕ фрагменты кода или текста из выданных файлов.
- Не предполагай содержимое файлов, которых в наборе нет.
- Безопасность туриста важнее всего: находки про SOS, офлайн, тревоги и Кузьмича ставь выше.
- Лучше десять находок с уликами, чем сто догадок.

Ответь СТРОГО одним JSON-объектом:
{"findings":[{"severity":"high|medium|low","kind":"rule_not_enforced|rule_duplicated|guard_toothless|failure_swallowed|missing_third_state|declared_not_real","files":["путь"],"what":"суть одной фразой","evidence":"дословно из файлов","proposal":"что делать"}]}`;

interface Finding {
  severity?: string; kind?: string; files?: string[];
  what?: string; evidence?: string; proposal?: string;
}

function parseFindings(raw: string): { findings: Finding[]; note: string | null; error: string | null } {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : raw).trim();
  const start = body.indexOf('{');
  if (start < 0) return { findings: [], note: null, error: 'в ответе нет JSON-объекта' };
  const end = body.lastIndexOf('}');
  if (end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1)) as { findings?: unknown };
      if (Array.isArray(parsed.findings)) return { findings: parsed.findings as Finding[], note: null, error: null };
    } catch { /* ниже спасение оборванного */ }
  }
  const arrAt = body.indexOf('[', start);
  if (arrAt < 0) return { findings: [], note: null, error: 'в ответе нет массива findings' };
  const salvaged = salvageTruncatedArray(body.slice(arrAt));
  if (salvaged.length === 0) return { findings: [], note: null, error: 'ответ оборван, целых находок не спасти' };
  return { findings: salvaged as Finding[], note: `ответ ОБОРВАН; спасено целых находок: ${salvaged.length}`, error: null };
}

async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error('OPENROUTER_API_KEY не задан — спросить некого.'); process.exit(1); }
  const model = process.argv[2] || 'openai/gpt-6-astra';
  const targets = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_TARGETS;

  const { files, skipped, bytes } = collect(targets);
  if (files.length === 0) {
    console.error('Набор пуст — читать нечего. Это отказ, а не «нарушений нет».');
    process.exit(1);
  }
  console.log(`набор: ${files.length} файлов, ${(bytes / 1024).toFixed(0)} КБ` + (skipped ? ` (не вместилось: ${skipped})` : ''));
  console.log(`модель: ${model}`);

  const known = new Set(files.map((f) => f.path));
  const payload = files.map((f) => `=== ФАЙЛ: ${f.path} ===\n${f.text}`).join('\n\n');

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(OPENROUTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${key}`, ...openRouterAttribution('os audit') },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: payload }],
        max_tokens: 32000,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(900_000),
    });
  } catch (err) {
    console.error('Модель не ответила:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`); process.exit(1); }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? null;
  const inTok = data.usage?.prompt_tokens ?? null;
  const outTok = data.usage?.completion_tokens ?? null;
  console.log(`ответ за ${((Date.now() - started) / 1000).toFixed(1)} с, токенов: вход ${inTok ?? '?'} / выход ${outTok ?? '?'}`);
  if (inTok !== null && outTok !== null) {
    const usd = inTok * 1e-5 + outTok * 5e-5; // прайс Astra из каталога
    console.log(`цена прохода: $${usd.toFixed(3)} (~${(usd * RUB_PER_USD).toFixed(0)} ₽, оценка по §8)`);
  }
  if (!text) { console.error('Ответ без содержимого.'); process.exit(1); }

  const { findings, note, error } = parseFindings(text);
  if (note) console.log(`ВНИМАНИЕ: ${note}`);
  if (error) {
    console.error('Разбор ответа не удался:', error);
    console.error(text.slice(0, 1200));
    process.exit(1);
  }

  // Детерминированная проверка: путь вне набора — признак выдумки.
  const good: Finding[] = [];
  let invented = 0;
  for (const f of findings) {
    const paths = Array.isArray(f.files) ? f.files : [];
    const real = paths.filter((p) => known.has(p));
    if (real.length === 0 || real.length !== paths.length) { invented += 1; continue; }
    good.push({ ...f, files: real });
  }

  const rank = (s?: string) => (s === 'high' ? 0 : s === 'medium' ? 1 : 2);
  good.sort((a, b) => rank(a.severity) - rank(b.severity));

  console.log(`\nнаходок: ${good.length} принято, ${invented} выброшено (ссылки на файлы вне набора)\n`);
  for (const f of good) {
    console.log('---');
    console.log(` [${f.severity ?? 'без важности'}] ${f.kind ?? 'род не назван'}`);
    for (const p of f.files ?? []) console.log(`   • ${p}`);
    console.log(` суть: ${f.what ?? '(не сказано)'}`);
    console.log(` улика: ${f.evidence ?? '(не приведена)'}`);
    console.log(` предложение: ${f.proposal ?? '(нет)'}`);
  }

  if (good.length === 0) {
    console.error('\nНи одной находки с уликой. «Всё чисто» и «модель не справилась» неразличимы — прогон красный.');
    process.exit(1);
  }
  console.log('\nНичего не изменено: аудит только читает. Решает человек.');
}

void main();
