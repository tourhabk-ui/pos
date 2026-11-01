/**
 * «Вся поездка» для оператора (02.11): заявка — часть поездки TRIP-…,
 * если в комментарии есть строка create_trip_request
 * «[Поездка TRIP-XXXXXX, N чел.] В этой же поездке: …». Контактов других
 * партнёров тут нет — только состав поездки.
 */
export function parseTripLine(comment: string | null | undefined): { tripId: string; people: string | null; parts: string[] } | null {
  if (!comment) return null;
  const m = /\[Поездка (TRIP-[A-F0-9]{6})(?:, (\d{1,2}) чел\.)?\] В этой же поездке: ([^\]]+?)\.(?:\s|$)/.exec(comment);
  if (!m) return null;
  return { tripId: m[1], people: m[2] ?? null, parts: m[3].split('; ').map((s) => s.trim()).filter(Boolean) };
}

export function TripBlock({ comment }: { comment: string | null | undefined }) {
  const t = parseTripLine(comment);
  if (!t) return null;
  return (
    <div className="rounded-lg border border-[var(--accent,#2563eb)] p-3 text-sm" data-testid="trip-block">
      <div className="font-medium">Вся поездка {t.tripId}{t.people ? ` · ${t.people} чел.` : ''}</div>
      <ul className="mt-1 list-disc pl-5">
        {t.parts.map((p) => <li key={p}>{p}</li>)}
      </ul>
      <div className="mt-1 text-xs opacity-70">Остальные части получили другие партнёры или менеджер Ведара; подтвердите свою — человек ждёт звонка.</div>
    </div>
  );
}
