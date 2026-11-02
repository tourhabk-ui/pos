/**
 * Кластеры плохих оценок Кузьмича (аудит агентов 02.11, пробел #5).
 *
 * Грейдер (lib/agents/managed/kuzmich-outcomes) пишет в agent_knowledge
 * «Оценка N/10. Проблемы: …», и эти записи копились без обзора. Здесь —
 * чистая раскладка текста проблем по повторяющимся типам. Без ПД: в пример
 * идёт только текст проблем от судьи, через redactPII и с обрезкой; вопрос
 * туриста и ответ бота сюда не попадают.
 */
import { redactPII } from '@/lib/security/pii-redact';

export interface ClusterDef { id: string; label: string; re: RegExp }

/** Порядок важен: запись попадает в ПЕРВЫЙ совпавший тип каждой проблемы. */
export const CLUSTERS: ClusterDef[] = [
  { id: 'ungrounded', label: 'Конкретика без вызова инструментов (незаземлённые факты)', re: /НЕЗАЗЕМЛЁННЫЕ ФАКТЫ/ },
  { id: 'grounding_unchecked', label: 'Заземление не проверено', re: /ЗАЗЕМЛЕНИЕ НЕ ПРОВЕРЕНО/ },
  { id: 'invented', label: 'Выдуманные или непроверенные факты, цены, туры', re: /выдум|недостовер|галлюцин|неверн|ошибочн|не существ|придума|непровер|сомнительн|неточн/i },
  { id: 'safety_missing', label: 'Не упомянута безопасность', re: /безопасн|риск|медвед|опасн/i },
  { id: 'off_topic', label: 'Не по теме или не ответил на вопрос', re: /не отвеча|не по теме|не по существу|уход|игнорир|не ответил|не относ/i },
  { id: 'incomplete', label: 'Неполный ответ (не хватает конкретики)', re: /не указ|неполн|отсутству|нет конкрет|не хватает|не привед|не дан|мало информ|общ(ий|ие|их) /i },
  { id: 'tone', label: 'Тон менеджера продаж / не голос места', re: /продаж|менеджер|тон|реклам|навязчив/i },
  { id: 'verbose', label: 'Вода, лишний текст, повторы', re: /вод[аыу]|длинн|лишн|повтор|многослов/i },
];

export interface OutcomeRowLite {
  compiled_truth: string;
  surface: string | null;
  provider: string | null;
  answer_path: string | null;
  outcome_kind: string | null;
  score: number | null;
}

export interface Cluster { id: string; label: string; count: number; by_surface: Record<string, number>; examples: string[] }

export function issueText(compiledTruth: string): string {
  const m = compiledTruth.match(/Проблемы:\s*([\s\S]*)$/);
  return m ? m[1]!.trim() : '';
}

/** Пример: только формулировка судьи, без ПД, коротко. */
export function anonymizeExample(text: string): string {
  return redactPII(text).replace(/\s+/g, ' ').slice(0, 160);
}

export function clusterOutcomes(rows: OutcomeRowLite[], maxExamples = 2): Cluster[] {
  const map = new Map<string, Cluster>();
  const bump = (id: string, label: string, surface: string, example: string | null) => {
    let c = map.get(id);
    if (!c) { c = { id, label, count: 0, by_surface: {}, examples: [] }; map.set(id, c); }
    c.count += 1;
    c.by_surface[surface] = (c.by_surface[surface] ?? 0) + 1;
    if (example && c.examples.length < maxExamples && !c.examples.includes(example)) c.examples.push(example);
  };
  for (const r of rows) {
    const surface = r.surface ?? 'не записана';
    if (r.outcome_kind === 'refusal') { bump('refusal', 'Отказ модели', surface, r.provider ? `провайдер: ${r.provider}` : null); continue; }
    const issues = issueText(r.compiled_truth);
    if (!issues) { bump('no_issue_text', 'Низкий балл без текста проблем', surface, null); continue; }
    const parts = issues.split(/;\s*/).filter(Boolean);
    const seen = new Set<string>();
    for (const p of parts) {
      const def = CLUSTERS.find((d) => d.re.test(p));
      const id = def?.id ?? 'other';
      if (seen.has(id)) continue;
      seen.add(id);
      bump(id, def?.label ?? 'Прочее', surface, anonymizeExample(p));
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
