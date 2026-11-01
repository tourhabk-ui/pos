/**
 * Линза эволюции «Кузьмич застревает» (01.11, карт-бланш владельца).
 *
 * Читает замеры ответов Кузьмича за 7 суток (`ai_actions_log`, action_type
 * `kuzmich_answer`, признаки — lib/kuzmich/loop-stall) и превращает частое
 * застревание цикла в находку 'suggested'. Дальше — как у любой находки:
 * issue-reporter выносит её в GitHub Issues, чинит человек или Claude Code
 * правкой кода и со сторожем.
 *
 * Чего здесь нет намеренно: модели. Предложение, с которого это началось,
 * отдавало модели-супервизору и диагноз, и лекарство — она сочиняла роль и
 * сама вписывала её в промпт Кузьмича. Здесь диагноз — доля в журнале, а
 * лекарство не выбирается вовсе: находка называет числа и инструменты, где
 * застревает, а что чинить — описание инструмента, валидатор, сам инструмент
 * или промпт — решает тот, кто правит код.
 *
 * Пороги — начальные, а не замер: в журнале признаков ещё нет ни одной строки.
 * Их пересматривают по первой неделе данных; до тех пор находка честно
 * называет и долю, и порог, и размер выборки.
 */

import { pool } from '@/lib/db-pool';
import { KUZMICH_ANSWER_ACTION } from '@/lib/kuzmich/answer-ceiling';
import type { GrowthIssue } from '@/lib/agents/evo/growth-agent';

/** Окно переписи, суток. */
export const STALL_WINDOW_DAYS = 7;
/** Меньше ответов с признаками в группе — приговор не выносится. */
export const STALL_MIN_SAMPLE = 20;

/** Одна группа замеров: поверхность × провайдер, только ответы, где цикл ходил. */
export interface StallGroupRow {
  surface: string;
  provider: string;
  measured: number;
  turns_exhausted: number;
  with_dup_calls: number;
  with_invalid_args: number;
  with_tool_failures: number;
}

export interface StallToolRow {
  tool: string;
  answers: number;
}

type SignalKey = 'turns_exhausted' | 'with_tool_failures' | 'with_dup_calls' | 'with_invalid_args';

interface Signal {
  key: SignalKey;
  /** Порог доли ответов группы, с которого это находка. */
  threshold: number;
  severity: GrowthIssue['severity'];
  title: string;
  what: string;
  suggestion: string;
}

/**
 * Порядок — по цене для туриста. Исчерпанные ходы и упавший инструмент
 * значат, что ответ собран БЕЗ данных платформы; повтор и неверные аргументы
 * стоят времени и денег, но ответ ещё может быть верным.
 */
export const STALL_SIGNALS: readonly Signal[] = [
  {
    key: 'turns_exhausted', threshold: 0.05, severity: 'high',
    title: 'Кузьмич застревает: ходы кончаются без ответа',
    what: 'цикл истратил все ходы на инструменты и ответа не дал — отвечал запасной путь без данных платформы',
    suggestion: 'Взять инструменты из списка ниже и посмотреть, почему их вывода модели не хватает для ответа: неполный вывод, описание инструмента зовёт уточнять, или вопрос требует инструмента, которого нет.',
  },
  {
    key: 'with_tool_failures', threshold: 0.05, severity: 'high',
    title: 'Кузьмич застревает: инструменты падают',
    what: 'инструмент упал при исполнении (лог «[kuzmich-tool] исполнение упало» с SQLSTATE)',
    suggestion: 'Найти в логах прода строки «[kuzmich-tool] исполнение упало» по инструментам ниже и починить сам инструмент; запрос — на настоящем PostgreSQL (скилл pg-verify).',
  },
  {
    key: 'with_dup_calls', threshold: 0.15, severity: 'medium',
    title: 'Кузьмич застревает: повторяет тот же вызов',
    what: 'модель повторно звала инструмент с теми же аргументами, хотя ответ уже лежал выше',
    suggestion: 'Посмотреть вывод инструментов ниже: модель повторяет вызов, когда вывод не похож на ответ (пустой, обрезанный, без явного «нет данных»). Чинить вывод или описание инструмента, не промпт перечнем случаев.',
  },
  {
    key: 'with_invalid_args', threshold: 0.10, severity: 'medium',
    title: 'Кузьмич застревает: неверные аргументы',
    what: 'валидатор отверг аргументы вызова',
    suggestion: 'Сверить схему инструментов ниже (lib/kuzmich/tool-schemas) с тем, что модель в них кладёт: неясное описание параметра или схема строже, чем нужно.',
  },
];

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/**
 * Чистая: группы и инструменты → находки, не больше одной на признак (худшая
 * группа; прочие над порогом названы в описании). Группы меньше выборки не
 * судятся — ни «плохо», ни «хорошо».
 */
export function pickStallFindings(groups: readonly StallGroupRow[], tools: readonly StallToolRow[]): GrowthIssue[] {
  const judged = groups.filter((g) => g.measured >= STALL_MIN_SAMPLE);
  const toolLine = tools.length
    ? `Инструменты с признаками застревания (ответов): ${tools.map((t) => `${t.tool} ${t.answers}`).join(', ')}.`
    : 'Имена инструментов в замерах не записаны.';
  const out: GrowthIssue[] = [];

  for (const s of STALL_SIGNALS) {
    const over = judged
      .map((g) => ({ g, share: g[s.key] / g.measured }))
      .filter((x) => x.share >= s.threshold)
      .sort((a, b) => b.share - a.share);
    if (over.length === 0) continue;
    const groupLine = over
      .map(({ g, share }) => `${g.surface} / ${g.provider}: ${g[s.key]} из ${g.measured} (${pct(share)})`)
      .join('; ');
    out.push({
      category: 'bug',
      severity: s.severity,
      model: 'deterministic',
      status: 'suggested',
      title: s.title,
      description:
        `За ${STALL_WINDOW_DAYS} суток ${s.what}. Доля ответов выше порога ${pct(s.threshold)}: ${groupLine}. ` +
        `${toolLine} Судятся группы от ${STALL_MIN_SAMPLE} ответов. ` +
        'Источник — замеры ответов (ai_actions_log, kuzmich_answer), признаки — lib/kuzmich/loop-stall; текстов реплик в замерах нет.',
      suggestion: s.suggestion,
    });
  }
  return out;
}

export const STALL_GROUPS_SQL = `
  SELECT COALESCE(metadata->>'surface', 'не записана') AS surface,
         COALESCE(provider, 'не записан')             AS provider,
         COUNT(*)::int                                AS measured,
         COUNT(*) FILTER (WHERE metadata->>'stall_turns_exhausted' = 'true')::int AS turns_exhausted,
         COUNT(*) FILTER (WHERE (metadata->>'stall_dup_calls')::int > 0)::int      AS with_dup_calls,
         COUNT(*) FILTER (WHERE (metadata->>'stall_invalid_args')::int > 0)::int   AS with_invalid_args,
         COUNT(*) FILTER (WHERE (metadata->>'stall_tool_failures')::int > 0)::int  AS with_tool_failures
    FROM ai_actions_log
   WHERE action_type = $1
     AND created_at > NOW() - ($2::int * INTERVAL '1 day')
     AND metadata ? 'stall_turns_exhausted'
   GROUP BY 1, 2`;

export const STALL_TOOLS_SQL = `
  SELECT t AS tool, COUNT(*)::int AS answers
    FROM ai_actions_log,
         jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(metadata->'stall_tools') = 'array' THEN metadata->'stall_tools' ELSE '[]'::jsonb END
         ) AS t
   WHERE action_type = $1
     AND created_at > NOW() - ($2::int * INTERVAL '1 day')
   GROUP BY t
   ORDER BY answers DESC, t
   LIMIT 5`;

export async function scanKuzmichStall(): Promise<GrowthIssue[]> {
  const params = [KUZMICH_ANSWER_ACTION, STALL_WINDOW_DAYS];
  const [{ rows: groups }, { rows: tools }] = await Promise.all([
    pool.query<StallGroupRow>(STALL_GROUPS_SQL, params),
    pool.query<StallToolRow>(STALL_TOOLS_SQL, params),
  ]);
  return pickStallFindings(groups, tools);
}
