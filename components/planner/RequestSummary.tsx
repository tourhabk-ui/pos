/**
 * Сводка «Что уйдёт в заявке» над контактами формы /planner (проверка
 * сценариев 07.11): человек видит даты, состав, пожелания и план до отправки.
 * Строки — `tripRequestLines` из того же `source_data`, что уходит в заявку:
 * их же читают менеджер, оператор и напоминание.
 */
export function RequestSummary({ lines, healthNoted }: { lines: readonly string[]; healthNoted: boolean }) {
  return (
    <section aria-label="Что уйдёт в заявке" className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3 space-y-1">
      <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Что уйдёт в заявке</p>
      {lines.length > 0 ? (
        <ul className="space-y-0.5">
          {lines.map((line) => (
            <li key={line} className="text-sm text-[var(--text-secondary)]">{line}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">
          Даты, состав группы и план ещё не выбраны — напишите о поездке своими словами ниже.
        </p>
      )}
      {healthNoted && (
        <p className="text-xs text-[var(--text-muted)]">
          Заметка о здоровье в заявку не уходит: она нужна только для подбора. Если оператору важно о ней знать, напишите своими словами ниже.
        </p>
      )}
    </section>
  );
}
