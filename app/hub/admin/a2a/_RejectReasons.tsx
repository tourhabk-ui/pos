'use client';

/**
 * Отчего задачи A2A отклонены — на странице журнала (слово владельца 13.11).
 *
 * До этого дня «отказ» в таблицах не говорил причины, а подпись под ними
 * перечисляла четыре возможных разом. Здесь два куска, которые рисуют причину
 * словами: исход одной строки журнала и сводка отказов окна по причинам.
 *
 * Слова причины приходят с сервера (lib/a2a/reject-reason) — второго словаря
 * на клиенте нет. Сторож: tests/unit/a2a-reject-reason.test.tsx.
 */

export interface OutcomeRow {
  ok: boolean;
  state: string | null;
  error_code: string | null;
  method: string | null;
  reject_code?: string | null;
  reject_label?: string | null;
}

export interface ReasonRow {
  code: string | null;
  label: string;
  tool: string | null;
  tasks: number;
  agents: number;
}

const STATE_WORD: Record<string, string> = { completed: 'выполнено', rejected: 'отказ', failed: 'сбой' };

/** Исход строки журнала: выполнено, отказ с причиной, сбой или ошибка протокола. */
export function RequestOutcome({ r }: { r: OutcomeRow }) {
  if (!r.ok) {
    return (
      <span className="text-[var(--warning)]">
        ошибка: {r.error_code ?? '?'}{r.method ? <> · <code>{r.method}</code></> : null}
      </span>
    );
  }
  if (r.state === 'rejected') {
    return (
      <span className="text-[var(--warning)]">
        отказ: {r.reject_label ?? 'причина не записана'}
        {r.reject_code ? <> <code className="text-[var(--text-muted)]">{r.reject_code}</code></> : null}
      </span>
    );
  }
  return <span>{r.state ? STATE_WORD[r.state] ?? r.state : 'ответ'}</span>;
}

/** Отказы окна по причинам. Пусто — отказов за окно не было, и это сказано. */
export function RejectReasons({ rows, days }: { rows: ReasonRow[]; days: number }) {
  const unknown = rows.filter((r) => !r.code).reduce((s, r) => s + r.tasks, 0);
  return (
    <div className="ds-card p-4 overflow-x-auto">
      <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">Отказы по причинам (за {days} дн.)</p>
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">За окно ни одна задача не отклонена.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className="text-left font-medium text-[var(--text-muted)] pb-1 pr-3">Причина</th>
              <th className="text-left font-medium text-[var(--text-muted)] pb-1 pr-3">Инструмент</th>
              <th className="text-right font-medium text-[var(--text-muted)] pb-1 pr-3">Отказов</th>
              <th className="text-right font-medium text-[var(--text-muted)] pb-1">Агентов</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.code ?? '-'}:${r.tool ?? '-'}`} className="border-t border-[var(--border)]">
                <td className="py-1 pr-3 text-[var(--text-primary)]">
                  {r.label}{r.code ? <> <code className="text-[var(--text-muted)]">{r.code}</code></> : null}
                </td>
                <td className="py-1 pr-3 text-[var(--text-secondary)]">{r.tool ? <code>{r.tool}</code> : 'текстовый вопрос'}</td>
                <td className="py-1 pr-3 text-right tabular-nums text-[var(--text-primary)]">{r.tasks}</td>
                <td className="py-1 text-right tabular-nums text-[var(--text-muted)]">{r.agents}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unknown > 0 && (
        <p className="text-[10px] text-[var(--text-muted)] mt-2">
          «Причина не записана» — {unknown}: эти отказы записаны до 13.11, когда журнал причину ещё не хранил.
          Узнать её задним числом нечем.
        </p>
      )}
    </div>
  );
}
