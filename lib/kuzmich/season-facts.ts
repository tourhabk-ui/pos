/**
 * Сезон посещения — только проверяемые факты с источником (эвал season-2 и
 * route-2, 03.11: промпт говорил «июнь–сентябрь», в БД стояло «all», судья
 * промпта не видит). Блок идёт в контекст ответа и судьи. Нет источника —
 * места здесь нет, и Кузьмич говорит, что сезон подтвердит оператор.
 */
export interface SeasonFact {
  place: string;
  match: RegExp;
  season: string;
  sources: string[];
}

export const SEASON_FACTS: readonly SeasonFact[] = [
  {
    place: 'Долина гейзеров (Кроноцкий заповедник)',
    match: /гейзер|кроноцк|узон/i,
    season:
      'туристический сезон экскурсий — конец мая – конец сентября (доставка вертолётом, зависит от погоды); ' +
      'в мае и июне на маршруте ограничения или приостановка посещений («месячник тишины» — брачный период медведей, гнездование птиц), режим уточнять заранее; ' +
      'зимой регулярных экскурсий нет — заповедник лишь прорабатывает расширение сезона',
    sources: [
      'https://kronoki.ru/ru/news/newswire/2840.html',
      'https://kronoki.ru/ru/visit/information-for-all/excursions/147.html',
      'https://kronoki.ru/ru/visit/information-for-all/preparing-for-travel/',
    ],
  },
];

export function seasonFactsBlock(question: string): string {
  const hits = SEASON_FACTS.filter((f) => f.match.test(question));
  if (!hits.length) return '';
  return `СЕЗОН ПОСЕЩЕНИЯ (проверенные данные с источником):\n${hits
    .map((f) => `- ${f.place}: ${f.season} (источник: ${f.sources.join(', ')})`)
    .join('\n')}`;
}
