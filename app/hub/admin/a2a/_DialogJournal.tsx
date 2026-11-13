'use client';

/**
 * Журнал общения A2A на /hub/admin/a2a: что агент спросил у Кузьмича и что
 * тот ответил (решение владельца 13.10) — и перевод на русский по кнопке
 * (слово владельца 13.11: «нужно кнопку в журнал добавить перевести, много
 * китайцев подключилось»).
 *
 * Кнопок две: «Перевести» у реплики и «Перевести все» над списком — она
 * проходит реплики не по-русски по одной. Перевод показывается РЯДОМ с
 * исходником и с пометкой «машинный»: по нему читают, по исходнику проверяют.
 * Перевод хранится в строке журнала (миграция 1437), поэтому при следующем
 * открытии страницы он уже на месте.
 *
 * Исходы у поля — как у двери (lib/a2a/dialog-translate): переведено, уже
 * лежало, по-русски (переводить нечего), не смог — с причиной словами. «Не
 * смог» не выдаётся за «перевода нет» (§4.0).
 *
 * Сторож: tests/unit/a2a-dialog-translate.test.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Languages } from 'lucide-react';

export type AgentKind = 'external' | 'registry' | 'probe' | 'self';

export interface DialogItem {
  /** Нет у старой сборки сервера — тогда перевод не предлагается. */
  id?: number;
  at: string; agent: string; kind: AgentKind; dialog: string | null; turn: number;
  question: string; answer: string; state: string; duration_ms: number | null;
  ip?: string | null; user_agent?: string | null;
  question_ru?: string | null; answer_ru?: string | null;
  question_foreign?: boolean; answer_foreign?: boolean;
}

export interface DialogsData { since: string | null; total: number; retention_days: number; limit: number; items: DialogItem[] }

type FieldOutcome =
  | { status: 'translated' | 'stored'; text: string }
  | { status: 'not_needed' }
  | { status: 'failed'; reason: string };

/** Что страница знает о переводе реплики сверх пришедшего с сервера. */
interface RowState {
  busy?: boolean;
  question_ru?: string;
  answer_ru?: string;
  /** Отказ по полю или по всей реплике — словами, как сказала дверь. */
  question_error?: string;
  answer_error?: string;
  error?: string;
}

export const KIND_LABEL: Record<AgentKind, string> = {
  external: 'внешний',
  registry: 'проверка реестра A2A',
  probe: 'проверка',
  self: 'свой',
};

export const STATE_LABEL: Record<string, string> = { completed: 'выполнено', rejected: 'отказ', failed: 'сбой' };

export function kindClass(kind: AgentKind): string {
  if (kind === 'external') return 'text-[var(--success)]';
  if (kind === 'self') return 'text-[var(--text-muted)]';
  return 'text-[var(--text-secondary)]';
}

const questionRu = (d: DialogItem, s: RowState | undefined) => s?.question_ru ?? d.question_ru ?? null;
const answerRu = (d: DialogItem, s: RowState | undefined) => s?.answer_ru ?? d.answer_ru ?? null;

/** Есть ли у реплики поле не по-русски, которое ещё не переведено. */
function wantsTranslation(d: DialogItem, s: RowState | undefined): boolean {
  if (typeof d.id !== 'number') return false;
  return (d.question_foreign === true && !questionRu(d, s)) || (d.answer_foreign === true && !answerRu(d, s));
}

function isFieldOutcome(v: unknown): v is FieldOutcome {
  if (!v || typeof v !== 'object') return false;
  const o = v as { status?: unknown; text?: unknown; reason?: unknown };
  if (o.status === 'translated' || o.status === 'stored') return typeof o.text === 'string' && o.text.trim() !== '';
  if (o.status === 'failed') return typeof o.reason === 'string';
  return o.status === 'not_needed';
}

/** Ответ двери → что показать у реплики. Ответ не той формы — отказ, а не «перевода нет». */
async function requestTranslation(id: number): Promise<RowState> {
  let res: Response;
  try {
    res = await fetch('/api/admin/analytics/a2a/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch {
    return { error: 'запрос не дошёл до сервера' };
  }
  const json: unknown = await res.json().catch(() => null);
  const body = (json ?? {}) as { success?: unknown; error?: unknown; question?: unknown; answer?: unknown };
  if (!res.ok || body.success !== true) {
    return { error: typeof body.error === 'string' ? body.error : `сервер ответил ${res.status}` };
  }
  if (!isFieldOutcome(body.question) || !isFieldOutcome(body.answer)) return { error: 'ответ сервера не той формы' };
  const out: RowState = {};
  if (body.question.status === 'translated' || body.question.status === 'stored') out.question_ru = body.question.text;
  if (body.question.status === 'failed') out.question_error = body.question.reason;
  if (body.answer.status === 'translated' || body.answer.status === 'stored') out.answer_ru = body.answer.text;
  if (body.answer.status === 'failed') out.answer_error = body.answer.reason;
  return out;
}

function Translation({ text }: { text: string }) {
  return (
    <p className="mt-1 border-l-2 border-[var(--ocean)] pl-2 text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">
      <span className="text-[var(--text-muted)]">Перевод (машинный): </span>{text}
    </p>
  );
}

function TranslationError({ what, reason }: { what: string; reason: string }) {
  return <p className="mt-1 text-xs text-[var(--warning)]">{what} не переведён: {reason}</p>;
}

/**
 * Одна реплика разговора: вопрос агента целиком, ответ Кузьмича — свёрнутым
 * (ответы длинные, а глазами сперва ищут, ЧТО спрашивают). Ключ диалога —
 * 8 знаков hash: реплики одного разговора узнаются по нему.
 */
function DialogEntry({ d, s, onTranslate }: { d: DialogItem; s: RowState | undefined; onTranslate: (id: number) => void }) {
  const qRu = questionRu(d, s);
  const aRu = answerRu(d, s);
  const offer = wantsTranslation(d, s);
  return (
    <li className="border-t border-[var(--border)] pt-3 first:border-t-0 first:pt-0">
      <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
        {d.at} · <span className="font-medium text-[var(--text-primary)]">{d.agent}</span>{' '}
        <span className={kindClass(d.kind)}>· {KIND_LABEL[d.kind]}</span>
        {d.dialog ? ` · разговор ${d.dialog}, реплика ${d.turn}` : ''}
        {' · '}
        <span className={d.state === 'completed' ? '' : 'text-[var(--warning)]'}>{STATE_LABEL[d.state] ?? d.state}</span>
        {d.duration_ms !== null ? ` · ${d.duration_ms} мс` : ''}
      </p>
      {(d.ip || d.user_agent) && (
        <p className="text-[11px] text-[var(--text-muted)] break-all">
          {d.ip ? (
            <>IP <a className="text-[var(--ocean)] underline" href={`https://ipinfo.io/${encodeURIComponent(d.ip)}`} target="_blank" rel="noopener noreferrer">{d.ip}</a></>
          ) : 'IP —'}
          {d.user_agent ? ` · ${d.user_agent}` : ''}
        </p>
      )}
      <p className="mt-1 text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">
        <span className="text-[var(--text-muted)]">Вопрос: </span>{d.question}
      </p>
      {qRu && <Translation text={qRu} />}
      {s?.question_error && <TranslationError what="Вопрос" reason={s.question_error} />}
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-[var(--ocean)]">Ответ Кузьмича{aRu ? ' · есть перевод' : ''}</summary>
        <p className="mt-1 text-sm text-[var(--text-secondary)] whitespace-pre-wrap break-words">{d.answer}</p>
        {aRu && <Translation text={aRu} />}
      </details>
      {s?.answer_error && <TranslationError what="Ответ" reason={s.answer_error} />}
      {s?.error && <p className="mt-1 text-xs text-[var(--warning)]">Перевод не получен: {s.error}</p>}
      {offer && typeof d.id === 'number' && (
        <button
          type="button"
          disabled={s?.busy === true}
          onClick={() => onTranslate(d.id as number)}
          className="mt-1 inline-flex min-h-[44px] items-center gap-1 text-xs text-[var(--ocean)] underline disabled:opacity-60 sm:min-h-0"
        >
          <Languages className="h-3.5 w-3.5" aria-hidden />
          {s?.busy ? 'Перевожу…' : 'Перевести'}
        </button>
      )}
    </li>
  );
}

export default function DialogJournal({ data }: { data: DialogsData }) {
  const [rows, setRows] = useState<Record<number, RowState>>({});
  /** Идёт ли проход «Перевести все» и сколько реплик он уже прошёл. */
  const [run, setRun] = useState<{ done: number; total: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const translateOne = useCallback(async (id: number): Promise<void> => {
    setRows((r) => ({ ...r, [id]: { ...r[id], busy: true, error: undefined, question_error: undefined, answer_error: undefined } }));
    const out = await requestTranslation(id);
    if (!alive.current) return;
    setRows((r) => ({ ...r, [id]: { question_ru: r[id]?.question_ru, answer_ru: r[id]?.answer_ru, ...out, busy: false } }));
  }, []);

  const pending = data.items.filter((d) => wantsTranslation(d, rows[d.id ?? -1]));

  const translateAll = async (): Promise<void> => {
    const ids = pending.map((d) => d.id as number);
    setRun({ done: 0, total: ids.length });
    // По одной: ответ Кузьмича длинный, модель переводит его десятки секунд,
    // а пачка параллельных вызовов упёрлась бы в предел провайдера.
    for (let i = 0; i < ids.length; i++) {
      if (!alive.current) return;
      await translateOne(ids[i]);
      if (alive.current) setRun({ done: i + 1, total: ids.length });
    }
    if (alive.current) setRun(null);
  };

  const failed = data.items.filter((d) => {
    const s = rows[d.id ?? -1];
    return Boolean(s && (s.error || s.question_error || s.answer_error));
  }).length;

  return (
    <div className="ds-card p-4">
      <p className="text-[10px] text-[var(--text-muted)] mb-3">
        Последние {data.items.length} из {data.total} реплик (ведётся с {data.since}).
        Телефоны и почты вычищены до записи, текст хранится {data.retention_days} суток.
        Вызовы инструментов без текста — в «Последних запросах» выше.
      </p>
      {(pending.length > 0 || run || failed > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          {(pending.length > 0 || run) && (
            <button
              type="button"
              disabled={run !== null}
              onClick={() => { void translateAll(); }}
              className="ds-btn ds-btn-secondary inline-flex items-center gap-2 text-sm"
            >
              <Languages className="h-4 w-4" aria-hidden />
              {run ? `Перевожу: ${run.done} из ${run.total}` : `Перевести все не по-русски: ${pending.length}`}
            </button>
          )}
          <p className="text-xs text-[var(--text-muted)]" aria-live="polite">
            Перевод машинный и хранится вместе с репликой; исходник остаётся рядом.
            {failed > 0 ? ` Не переведено реплик: ${failed} — причина названа у каждой.` : ''}
          </p>
        </div>
      )}
      <ul className="space-y-3">
        {data.items.map((d, i) => (
          <DialogEntry key={d.id ?? `${d.at}:${i}`} d={d} s={rows[d.id ?? -1]} onTranslate={(id) => { void translateOne(id); }} />
        ))}
      </ul>
    </div>
  );
}
