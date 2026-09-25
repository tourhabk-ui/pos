/**
 * Фильтр каталога туров по слову туриста — для `get_tours` (Кузьмич и MCP).
 *
 * Фильтр по типу объявлен в схеме с самого начала, но executeTool его
 * игнорировал (аудит 08.08). Матчим и слаг (fishing), и русскую метку
 * (Рыбалка) — модель передаёт слово туриста.
 *
 * Слово туриста — не всегда тип (сверка MCP 25.09): «вулканы» типом тура не
 * бывает и уходили в «по типу нет» плюс полный каталог рыбалки. Теперь второй
 * ступенью — упоминание в названии или описании (основа слова без окончания,
 * чтобы «вулканы» нашли «вулкан» и «вулканов»), с пометкой «тип другой».
 * Ничего нет — сказано прямо, и каталог идёт как замена с оговоркой, а не
 * как ответ на спрошенное.
 */
export function filterTourCatalog(ctx: string, want: string, activityLabel: (slug: string) => string): string {
  const lines = ctx.split('\n');
  const isTourLine = (l: string) => /^ID\d+:/.test(l);
  const matches = (l: string) => {
    const type = (l.match(/тип:(\S+)/)?.[1] ?? '').toLowerCase();
    const label = activityLabel(type).toLowerCase();
    return type.includes(want) || label.includes(want) || (label.length > 2 && want.includes(label));
  };
  const kept = lines.filter((l) => !isTourLine(l) || matches(l));
  if (kept.filter(isTourLine).length > 0) return kept.join('\n');

  const stems = want.split(/\s+/).filter((w) => w.length >= 4).map((w) => w.slice(0, Math.max(4, w.length - 2)));
  const mentioned = lines.filter((l) => isTourLine(l) && stems.length > 0
    && stems.every((st) => l.toLowerCase().includes(st)));
  if (mentioned.length > 0) {
    return `Тура с типом «${want}» нет. Упоминают «${want}» в названии или описании — тип у них другой, `
      + `уточни через get_tour_details, прежде чем предлагать:\n${mentioned.join('\n')}`;
  }
  return `Туров «${want}» у операторов платформы сейчас нет — ни по типу, ни в описаниях. `
    + `Не выдавай другие туры за такие. Весь каталог — для замены с явной оговоркой:\n${ctx}`;
}
