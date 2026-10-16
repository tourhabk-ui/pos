/**
 * scripts/ai-visibility-panel.ts — панель «Ведар в ответах ИИ-ассистентов».
 *
 * Замер владельца 16.10; критерии записаны до первого прогона —
 * docs/agents/AI_VISIBILITY.md. Счёт — lib/ai/visibility-panel.ts, вопросы
 * ассистентам — lib/ai/visibility-ask.ts; здесь — режимы маркера, файлы и печать.
 *
 * Запуск: npx tsx scripts/ai-visibility-panel.ts <маркер> <папка вывода> [папка сырья]
 *
 * Режим — поле "mode" маркера:
 *   dry    — набор вопросов, модели дня и цена; ни одного вызова модели;
 *   apply  — один день панели: каждый вопрос каждому ассистенту "repeats" раз,
 *            под потолком "max_usd". Оценка дня выше потолка или цена,
 *            которую каталог не назвал, — отказ до первого вызова;
 *   report — доли по сырью прошлых прогонов ("baseline_runs", "followup_runs"
 *            — номера прогонов workflow; сырьё скачано в [папку сырья]/<номер>),
 *            карта источников и вердикт К1/К2 при заданных "competitors".
 *
 * Код выхода 1 — набор пуст, ни один ответ не получен, отказ потолка или
 * сырьё несовместимо (разные наборы вопросов): ноль на ненулевом входе —
 * отказ, а не успех (§4.0).
 *
 * Расход — в книги платформы через lib/ai/usage-sink (на раннере с
 * CRON_SECRET), agent_id 'ai-visibility-panel'. Плата за поиск в строки книг
 * не входит — её называет usage.cost OpenRouter в сырье и в сводке.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  domainRule,
  oursRule,
  parseQuestions,
  rankCitedDomains,
  renderShareTable,
  shareByAssistant,
  verdict,
  PANEL_INTENTS,
  type PanelAnswer,
  type Share,
} from '@/lib/ai/visibility-panel';
import {
  choosePanelModels,
  planDay,
  readPricedCatalog,
  runPanelDay,
  ASSISTANT_SPECS,
  PANEL_ASSISTANTS,
  PANEL_MAX_TOKENS,
  type AssistantId,
  type PanelModel,
  type PanelPlan,
  type PanelRecord,
} from '@/lib/ai/visibility-ask';
import { sendUsageToProd, usageSinkEnabled } from '@/lib/ai/usage-sink';

const DEFAULT_QUESTIONS = 'docs/agents/visibility/questions.json';
/** Вопросы о турах, датах и ценах — по ним выбираются конкуренты (правило в критериях). */
const COMPETITOR_INTENTS = ['tours_dates', 'prices'] as const;

interface Marker {
  mode: 'dry' | 'apply' | 'report';
  run: number | null;
  day: string;
  questions: string;
  repeats: number;
  assistants: AssistantId[];
  models: Partial<Record<AssistantId, string>>;
  max_usd: number | null;
  baseline_runs: string[];
  followup_runs: string[];
  competitors: string[];
}

/** Разбор маркера. Негодное поле — проблема со словами, а не тихое умолчание. */
export function parseMarker(raw: unknown): { marker: Marker; problems: string[] } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const mode = r.mode === undefined ? 'dry' : r.mode;
  if (mode !== 'dry' && mode !== 'apply' && mode !== 'report') problems.push(`mode «${String(mode)}» — не dry, apply или report`);
  const repeats = r.repeats === undefined ? 5 : r.repeats;
  if (typeof repeats !== 'number' || !Number.isInteger(repeats) || repeats < 1 || repeats > 10) problems.push('repeats — целое от 1 до 10');
  const assistants = r.assistants === undefined ? [...PANEL_ASSISTANTS] : r.assistants;
  const okAssistants = Array.isArray(assistants) && assistants.length > 0
    && assistants.every((a) => (PANEL_ASSISTANTS as readonly unknown[]).includes(a));
  if (!okAssistants) problems.push(`assistants — непустой список из ${PANEL_ASSISTANTS.join(', ')}`);
  const maxUsd = r.max_usd === undefined ? null : r.max_usd;
  if (maxUsd !== null && (typeof maxUsd !== 'number' || !(maxUsd > 0))) problems.push('max_usd — число больше нуля');
  const strList = (v: unknown, name: string): string[] => {
    if (v === undefined) return [];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.map(String);
    problems.push(`${name} — список`);
    return [];
  };
  const models: Partial<Record<AssistantId, string>> = {};
  if (r.models !== undefined) {
    if (r.models && typeof r.models === 'object' && !Array.isArray(r.models)) {
      for (const [k, v] of Object.entries(r.models as Record<string, unknown>)) {
        if ((PANEL_ASSISTANTS as readonly string[]).includes(k) && typeof v === 'string' && v.trim()) models[k as AssistantId] = v.trim();
        else problems.push(`models.${k} — не ассистент панели или не строка`);
      }
    } else problems.push('models — объект { ассистент: id модели }');
  }
  return {
    marker: {
      mode: (mode === 'apply' || mode === 'report' ? mode : 'dry'),
      run: typeof r.run === 'number' ? r.run : null,
      day: typeof r.day === 'string' && r.day.trim() ? r.day.trim() : 'day',
      questions: typeof r.questions === 'string' && r.questions.trim() ? r.questions.trim() : DEFAULT_QUESTIONS,
      repeats: typeof repeats === 'number' && Number.isInteger(repeats) && repeats >= 1 && repeats <= 10 ? repeats : 5,
      assistants: okAssistants ? (assistants as AssistantId[]) : [...PANEL_ASSISTANTS],
      models,
      max_usd: typeof maxUsd === 'number' && maxUsd > 0 ? maxUsd : null,
      baseline_runs: strList(r.baseline_runs, 'baseline_runs'),
      followup_runs: strList(r.followup_runs, 'followup_runs'),
      competitors: strList(r.competitors, 'competitors').map((d) => d.toLowerCase().replace(/^www\./, '')),
    },
    problems,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function summary(md: string): void {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p) return;
  try {
    appendFileSync(p, `${md}\n`);
  } catch (err) {
    console.error(`::warning::сводка в GITHUB_STEP_SUMMARY не записана: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const usd = (x: number | null) => (x === null ? 'не названа' : `$${x.toFixed(2)}`);

function notMeasuredList(models: readonly PanelModel[]) {
  return models.filter((m) => !m.model).map((m) => ({ assistant: m.assistant, reason: m.reason ?? 'причина не названа' }));
}

// ── dry / apply ─────────────────────────────────────────────────────────

/** Можно ли тратить: причина отказа или null. Проверяется до первого вызова модели. */
export function applyGate(maxUsd: number | null, plan: Pick<PanelPlan, 'est_usd' | 'calls'>): string | null {
  if (maxUsd === null) return 'apply без max_usd — потолок дня не задан, деньги не тратятся';
  if (plan.calls === 0) return 'ни одного ассистента спросить нечем — замера не будет';
  if (plan.est_usd === null) return 'каталог не назвал цену хотя бы одной модели — потолок не проверить, вызовов не будет';
  if (plan.est_usd > maxUsd) return `оценка дня ${usd(plan.est_usd)} выше потолка ${usd(maxUsd)} — вызовов не будет`;
  return null;
}

async function day(marker: Marker, outDir: string): Promise<number> {
  if (!existsSync(marker.questions)) {
    console.error(`::error::набора вопросов нет (${marker.questions}) — мерить нечем. Вопросы — из выгрузок Wordstat, Вебмастера и Search Console, у каждого источник.`);
    return 1;
  }
  const set = parseQuestions(readJson(marker.questions));
  for (const r of set.rejected) console.error(`::warning::вопрос #${r.index} не принят: ${r.reason}`);
  if (set.questions.length === 0) {
    console.error('::error::в наборе ни одного годного вопроса — мерить нечем (§4.0: ноль на входе — отказ)');
    return 1;
  }
  const byIntent = PANEL_INTENTS.map((i) => `${i} ${set.questions.filter((q) => q.intent === i).length}`).join(' · ');
  console.log(`вопросов ${set.questions.length} (${byIntent}), отклонено ${set.rejected.length}, sha256 ${set.sha256}`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  const catalog = await readPricedCatalog(fetch, apiKey);
  const models = choosePanelModels(catalog, marker.assistants, marker.models);
  const plan = planDay(set.questions, models, marker.repeats);
  for (const p of plan.per_assistant) {
    console.log(p.model
      ? `${ASSISTANT_SPECS[p.assistant].label}: ${p.model} — вызовов ${p.calls}, оценка ${usd(p.est_usd)}`
      : `${ASSISTANT_SPECS[p.assistant].label}: не измеряется — ${p.reason}`);
  }
  console.log(`всего вызовов ${plan.calls}, оценка дня ${usd(plan.est_usd)}, потолок ${marker.max_usd === null ? 'не задан' : usd(marker.max_usd)}`);

  mkdirSync(outDir, { recursive: true });
  const meta = {
    mode: marker.mode, run: marker.run, day: marker.day, asked_at: new Date().toISOString(),
    question_sha256: set.sha256, questions: set.questions.length, rejected: set.rejected,
    repeats: marker.repeats, models, plan,
    params: { max_tokens: PANEL_MAX_TOKENS, temperature: 'по умолчанию вендора', system_prompt: null, search: 'движок вендора' },
  };
  summary([
    `## Панель видимости — ${marker.mode === 'dry' ? 'план (dry)' : `день ${marker.day}`}`,
    '',
    `Вопросов ${set.questions.length} (${byIntent}), повторов ${marker.repeats}, вызовов ${plan.calls}, оценка ${usd(plan.est_usd)}.`,
    '',
    ...plan.per_assistant.map((p) => `- ${ASSISTANT_SPECS[p.assistant].label}: ${p.model ? `${p.model}, ${p.calls} вызовов, ${usd(p.est_usd)}` : `не измеряется — ${p.reason}`}`),
  ].join('\n'));

  if (plan.calls === 0) {
    writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
    console.error('::error::ни одного ассистента спросить нечем — замера не будет');
    return 1;
  }
  if (marker.mode === 'dry') {
    writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
    console.log('dry: вызовов моделей не было');
    return 0;
  }

  // apply: потолок проверяется ДО первого вызова.
  const refusal = applyGate(marker.max_usd, plan);
  if (refusal || marker.max_usd === null) {
    console.error(`::error::${refusal ?? 'потолок не задан'}`);
    return 1;
  }

  const result = await runPanelDay(set.questions, models, { day: marker.day, repeats: marker.repeats }, {
    fetchImpl: fetch, apiKey, maxUsd: marker.max_usd, concurrency: 6,
  });
  writeFileSync(join(outDir, 'answers.jsonl'), result.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify({ ...meta, spent_usd: result.spent_usd, stopped_by_budget: result.stopped_by_budget }, null, 2));

  const shares = shareByAssistant(result.records, oursRule);
  const brandOnly = result.records.filter((r) => r.marks?.brand_only).length;
  const answered = result.records.filter((r) => r.outcome === 'answered').length;
  console.log(`ответов ${answered} из ${result.records.length}; потрачено ${usd(result.spent_usd)}; не пошло из-за потолка ${result.stopped_by_budget}`);
  for (const r of result.records) {
    if (r.outcome !== 'answered') console.log(`${r.assistant}/${r.question_id}#${r.repeat}: ${r.outcome} — ${r.reason}`);
  }
  summary([
    '',
    renderShareTable(shares, notMeasuredList(models)),
    '',
    `Ответов ${answered} из ${result.records.length}; имя без домена — ${brandOnly}; потрачено ${usd(result.spent_usd)} (с поиском, по usage.cost OpenRouter); не пошло из-за потолка — ${result.stopped_by_budget}.`,
  ].join('\n'));

  const tokens = result.usage_rows.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0);
  if (result.usage_rows.length && usageSinkEnabled()) {
    const sent = await sendUsageToProd(result.usage_rows);
    console.log(sent ? `строк расхода в книги: ${result.usage_rows.length} (${tokens} токенов)` : '::warning::расход НЕ записан в книги — причина выше');
  } else if (result.usage_rows.length && process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::warning::расход НЕ записан в книги: на раннере нет CRON_SECRET (${result.usage_rows.length} строк, ${tokens} токенов)`);
  }

  if (answered === 0) {
    console.error('::error::ни одного ответа — замера нет');
    return 1;
  }
  return 0;
}

// ── report ──────────────────────────────────────────────────────────────

interface LoadedRun { id: string; sha: string; records: PanelRecord[]; models: PanelModel[] }

/** Сырьё одного прогона: <папка>/<номер>/…/meta.json и answers.jsonl (артефакт мог лечь вложенной папкой). */
function loadRun(inDir: string, id: string): LoadedRun | string {
  const root = join(inDir, id);
  if (!existsSync(root)) return `сырья прогона ${id} нет в ${inDir}`;
  const find = (dir: string, name: string): string | null => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory()) { const f = find(p, name); if (f) return f; }
    }
    return null;
  };
  const metaPath = find(root, 'meta.json');
  const answersPath = find(root, 'answers.jsonl');
  if (!metaPath || !answersPath) return `у прогона ${id} нет meta.json или answers.jsonl — это не день панели (dry?)`;
  const meta = readJson(metaPath) as { question_sha256?: unknown; models?: unknown };
  const records = readFileSync(answersPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as PanelRecord);
  return {
    id,
    sha: typeof meta.question_sha256 === 'string' ? meta.question_sha256 : '',
    records,
    models: Array.isArray(meta.models) ? (meta.models as PanelModel[]) : [],
  };
}

function report(marker: Marker, outDir: string, inDir: string): number {
  if (marker.baseline_runs.length === 0) {
    console.error('::error::report без baseline_runs — считать нечего');
    return 1;
  }
  const load = (ids: string[]) => ids.map((id) => loadRun(inDir, id));
  const base = load(marker.baseline_runs);
  const follow = load(marker.followup_runs);
  const broken = [...base, ...follow].filter((r): r is string => typeof r === 'string');
  if (broken.length) {
    for (const b of broken) console.error(`::error::${b}`);
    return 1;
  }
  const baseRuns = base as LoadedRun[];
  const followRuns = follow as LoadedRun[];
  const shas = new Set([...baseRuns, ...followRuns].map((r) => r.sha));
  if (shas.size !== 1) {
    console.error(`::error::наборы вопросов в прогонах разные (${[...shas].join(', ')}) — сравнивать нельзя`);
    return 1;
  }
  const baseRecs: PanelAnswer[] = baseRuns.flatMap((r) => r.records);
  const followRecs: PanelAnswer[] = followRuns.flatMap((r) => r.records);
  const notMeasured = notMeasuredList(baseRuns.flatMap((r) => r.models));

  const baseShares = shareByAssistant(baseRecs, oursRule);
  const cited = rankCitedDomains(baseRuns.flatMap((r) => r.records), COMPETITOR_INTENTS).slice(0, 30);
  const md: string[] = [
    '## Панель видимости — отчёт',
    '',
    `База: прогоны ${marker.baseline_runs.join(', ')}; ответов ${baseRecs.length}.`,
    '',
    renderShareTable(baseShares, notMeasured),
    '',
    '### Кого цитируют в ответах о турах, датах и ценах (база)',
    '',
    ...cited.map((c, i) => `${i + 1}. ${c.domain} — ${c.answers}`),
  ];
  const out: Record<string, unknown> = { question_sha256: [...shas][0], baseline: baseShares, cited_domains_tours_prices: cited };
  let exitCode = 0;

  if (followRuns.length) {
    const followShares = shareByAssistant(followRecs, oursRule);
    md.push('', `### Повтор: прогоны ${marker.followup_runs.join(', ')}`, '', renderShareTable(followShares, notMeasured));
    out.followup = followShares;
    if (marker.competitors.length === 0) {
      console.error('::error::конкуренты не записаны (competitors) — К2 не проверить, вердикта нет');
      md.push('', 'Вердикт: **не смог проверить** — конкуренты не записаны.');
      out.verdict = null;
      exitCode = 1;
    } else {
      const comp: Record<string, { baseline: Share[]; followup: Share[] }> = {};
      for (const d of marker.competitors) {
        comp[d] = { baseline: shareByAssistant(baseRecs, domainRule(d)), followup: shareByAssistant(followRecs, domainRule(d)) };
      }
      const v = verdict({ baseline: baseShares, followup: followShares }, comp);
      out.verdict = v;
      out.competitors = comp;
      const words = { met: 'выполнен', not_met: 'не выполнен', unknown: 'не смог проверить' } as const;
      md.push('', `Вердикт К1+К2: **${words[v.outcome]}**. Засчитаны: ${v.counted.join(', ') || 'никто'}; вычеркнуты (вырос и конкурент): ${v.struck.map((s) => `${s.assistant} (${s.competitors.join(', ')})`).join('; ') || 'нет'}; не измерены: ${v.unknown.join(', ') || 'нет'}.`);
    }
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(out, null, 2));
  const text = md.join('\n');
  console.log(text);
  summary(text);
  return exitCode;
}

async function main(): Promise<number> {
  const [markerPath, outDir = 'panel-out', inDir = 'panel-in'] = process.argv.slice(2);
  if (!markerPath || !existsSync(markerPath)) {
    console.error(`::error::маркер не найден: ${markerPath ?? '(не задан)'}`);
    return 1;
  }
  let raw: unknown;
  try {
    raw = readJson(markerPath);
  } catch (err) {
    console.error(`::error::маркер не разобран как JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const { marker, problems } = parseMarker(raw);
  for (const p of problems) console.error(`::error::маркер: ${p}`);
  if (problems.length) return 1;
  return marker.mode === 'report' ? report(marker, outDir, inDir) : day(marker, outDir);
}

if (process.argv[1] && process.argv[1].endsWith('ai-visibility-panel.ts')) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
