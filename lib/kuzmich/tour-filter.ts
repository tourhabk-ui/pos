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
 *
 * ── 08.10: «вулканы» не находили тип volcano ─────────────────────────────
 *
 * У тура «Восхождение на вулкан Ключевская Сопка» тип `volcano`, а ответ на
 * «вулканы» был «Тура с типом «вулканы» нет» — и тот же тур в списке «тип у
 * них другой». Тип сравнивался строкой целиком: «восхождение на вулкан» не
 * содержит «вулканы», а «вулканы» не содержит подписи. Теперь тип и слово
 * сравниваются ПО ОСНОВЕ, по каждому слову подписи во всех регистрах
 * словаря (полная, короткая, слаг): «вулканы» → «вулка» → «вулкан».
 *
 * И ответ больше не теряет туры: совпал тип — сначала они, а туры, где
 * слово стоит в названии или описании при другом типе (треккинг к вулкану,
 * облёт вулканов), идут следом отдельным блоком с той же оговоркой.
 */

type ActivityLabel = (slug: string, short?: boolean) => string;

/** ё→е и «кк»→«к»: «треккинг» и «трекинг» пишут оба, туристы — как придётся. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/кк/g, 'к');
}

/**
 * Основа слова: без двух последних букв у длинных, не короче четырёх.
 * «вулканы» → «вулка», «рыбалка» → «рыбал», «сплав» → «спла».
 */
export function wordStem(word: string): string {
  const w = normalize(word);
  return w.length >= 5 ? w.slice(0, Math.max(4, w.length - 2)) : w;
}

function words(s: string): string[] {
  return normalize(s).split(/[^a-zа-я]+/).filter(Boolean);
}

/**
 * Совпадает ли слово туриста с типом тура: по основе, с любым словом подписи
 * типа в любом регистре или со слагом; у просьбы из нескольких слов — каждое. Слова подписи короче четырёх букв
 * («на», «тур») не участвуют: «туры» иначе нашли бы и снегоходный, и
 * культурный, и фототур.
 */
export function typeMatches(slug: string, want: string, activityLabel: ActivityLabel): boolean {
  const s = slug.toLowerCase();
  if (!s) return false;
  const typeWords = [
    ...words(s.replace(/_/g, ' ')), s,
    ...words(activityLabel(s)),
    ...words(activityLabel(s, true)),
  ].filter((w) => w.length >= 4);
  const wantStems = words(want).filter((w) => w.length >= 3).map(wordStem);
  if (wantStems.length === 0) return false;
  // Каждое слово просьбы — у одного типа: «наблюдение за китами» иначе нашло
  // бы «Наблюдение за медведями» по первому слову.
  return wantStems.every((ws) => typeWords.some((tw) => tw.startsWith(ws) || ws.startsWith(wordStem(tw))));
}

export function filterTourCatalog(ctx: string, want: string, activityLabel: ActivityLabel): string {
  const lines = ctx.split('\n');
  const isTourLine = (l: string) => /^ID\d+:/.test(l);
  const firstTour = lines.findIndex(isTourLine);
  let lastTour = -1;
  lines.forEach((l, i) => { if (isTourLine(l)) lastTour = i; });
  const head = firstTour >= 0 ? lines.slice(0, firstTour) : lines;
  const tail = lastTour >= 0 ? lines.slice(lastTour + 1) : [];
  const tours = lines.filter(isTourLine);

  const byType = tours.filter((l) => typeMatches(l.match(/тип:(\S+)/)?.[1] ?? '', want, activityLabel));

  const stems = words(want).filter((w) => w.length >= 4).map(wordStem);
  const mentioned = tours.filter((l) => !byType.includes(l) && stems.length > 0
    && stems.every((st) => normalize(l).includes(st)));
  const mentionedNote = `Упоминают «${want}» в названии или описании — тип у них другой, `
    + 'уточни через get_tour_details, прежде чем предлагать:';

  if (byType.length > 0) {
    return [
      ...head,
      ...byType,
      ...(mentioned.length > 0 ? ['', `Ещё ${mentionedNote.charAt(0).toLowerCase()}${mentionedNote.slice(1)}`, ...mentioned] : []),
      ...tail,
    ].join('\n');
  }
  if (mentioned.length > 0) {
    return `Тура с типом «${want}» нет. ${mentionedNote}\n${mentioned.join('\n')}`;
  }
  return `Туров «${want}» у операторов платформы сейчас нет — ни по типу, ни в описаниях. `
    + `Не выдавай другие туры за такие. Весь каталог — для замены с явной оговоркой:\n${ctx}`;
}
