/**
 * Шаги заявки для страницы `/request-status` (12.11, «Step progress» из
 * каталога Motion по выбору владельца).
 *
 * Шаги берутся из состояния, которое уже говорит страница, — ни одного шага,
 * которого заявка не прошла на деле. Состояние, по которому путь не
 * восстановить (`unknown`, пробная `test`), шагов не получает: полоса
 * «почти готово» над нераспознанной заявкой была бы враньём (§4.0).
 *
 * Третий шаг — исход словами: подтверждено, отказ, другая дата, нет ответа.
 * Отказ и «нет ответа» — тоже конец пути, но не успех: у шага свой тон.
 */

import { ADDRESSEE_WORDS, type ConsentPurpose, type RequestState } from '@/lib/mcp/request-status-schema';

export type StepMark = 'done' | 'current' | 'todo';
export type StepTone = 'ok' | 'wait' | 'warn' | 'stop';

export interface RequestStep {
  label: string;
  mark: StepMark;
  tone: StepTone;
}

/** Слово исхода третьего шага и его тон. */
const OUTCOME: Partial<Record<RequestState, { label: string; tone: StepTone; mark: StepMark }>> = {
  confirmed: { label: 'Подтверждена', tone: 'ok', mark: 'done' },
  declined: { label: 'Отказ', tone: 'stop', mark: 'done' },
  cancelled: { label: 'Отменена', tone: 'stop', mark: 'done' },
  no_answer: { label: 'Нет ответа в срок', tone: 'warn', mark: 'done' },
  failed: { label: 'Ответ не записался', tone: 'warn', mark: 'done' },
  other_date: { label: 'Предложена другая дата', tone: 'warn', mark: 'current' },
  operator_contacted: { label: 'На связи', tone: 'wait', mark: 'current' },
  in_progress: { label: 'В работе', tone: 'wait', mark: 'current' },
  delivered: { label: 'Ответ звонком', tone: 'wait', mark: 'current' },
};

/** null — шагов не показывать: путь заявки по этому состоянию не восстановить. */
export function requestSteps(state: RequestState, purpose: ConsentPurpose): RequestStep[] | null {
  if (state === 'unknown' || state === 'test') return null;
  const sent: RequestStep = { label: 'Заявка отправлена', mark: 'done', tone: 'ok' };
  const handed: RequestStep = {
    label: `Передана ${ADDRESSEE_WORDS[purpose].dat}`,
    mark: state === 'awaiting_operator' ? 'current' : 'done',
    tone: state === 'awaiting_operator' ? 'wait' : 'ok',
  };
  const outcome = OUTCOME[state];
  const last: RequestStep = outcome
    ? { label: outcome.label, mark: outcome.mark, tone: outcome.tone }
    : { label: `Ответ ${ADDRESSEE_WORDS[purpose].gen}`, mark: 'todo', tone: 'wait' };
  return [sent, handed, last];
}

/** Сколько шагов пройдено, для полосы: 0..1. */
export function stepsProgress(steps: RequestStep[]): number {
  if (steps.length < 2) return steps.length === 1 && steps[0].mark === 'done' ? 1 : 0;
  const reached = steps.reduce((n, s, i) => (s.mark !== 'todo' ? i : n), 0);
  return reached / (steps.length - 1);
}

