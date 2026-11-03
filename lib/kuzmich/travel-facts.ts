/**
 * Дорога от Петропавловска-Камчатского — только проверяемые факты с источником
 * (решение владельца 03.11, эвал logistics-2/logistics-3: модель называла
 * «1–1,5 часа лёта», «3–3,5 часа» по памяти). Каждое число — со ссылкой на
 * официальную страницу или программу оператора. Нет источника — поля нет, и
 * Кузьмич говорит, что время дороги подтвердит оператор/перевозчик.
 *
 * Блок идёт в контекст ответа (aiChat) и судьи (askKuzmichForEval), поэтому
 * числа отсюда заземлены и distance-guard их не трогает.
 */

export interface TravelFact {
  place: string;
  /** Как место называют в вопросе (основа слова, нижний регистр). */
  match: RegExp;
  distance?: string;
  time?: string;
  sources: string[];
}

export const TRAVEL_FACTS: readonly TravelFact[] = [
  {
    place: 'Паратунка',
    match: /паратунк/i,
    distance: '60 км по автодороге к юго-западу от Петропавловска-Камчатского',
    sources: ['https://www.paratunka-sp.ru/poleznaya-informatsiya/kurort-paratunka/166-o-kurorte'],
  },
  {
    place: 'Малкинские горячие источники',
    match: /малк/i,
    distance: 'около 130 км от Петропавловска-Камчатского по трассе на Мильково, источники в 4 км от трассы (по прямой — 120 км к северо-западу)',
    time: 'на машине около 1,5–2 часов в одну сторону',
    sources: [
      'https://www.topkam.ru/attractions/mineral_springs/mineralnye_istochniki_malkinskie.html',
      'https://kamchatskiytour.ru/product/poseshhenie-malkinskih-gorjachih-istochnikov/',
      'https://nextroute.ru/experience/poezdka-k-malkinskim-termalynim-istochnikam-11264',
      'https://ru.wikipedia.org/wiki/Малки_(Камчатский_край)',
    ],
  },
  {
    place: 'Природный парк Налычево',
    match: /налычев/i,
    time: 'на внедорожнике по лесной грунтовой дороге до центральной части парка 8–9 часов (с бродами через реки)',
    sources: ['https://polusm.ru/services/nalychevo9'],
  },
  {
    place: 'Вулкан Мутновский',
    match: /мутновск/i,
    distance: '70 км к югу от Петропавловска-Камчатского',
    sources: ['http://earth.leeds.ac.uk/esc_wg/Oldwork/Kamchatka/volcano.htm'],
  },
  {
    place: 'Авачинский вулкан',
    match: /авачинск(?:ий|ого|ом|ому)\s+вулкан|вулкан[аеу]?\s+авачинск|авач[уеаи](?![а-яё])/i,
    distance: '30 км к северу от Петропавловска-Камчатского',
    sources: ['http://earth.leeds.ac.uk/esc_wg/Oldwork/Kamchatka/volcano.htm'],
  },
  {
    place: 'Вулкан Плоский Толбачик',
    match: /толбачик/i,
    distance: 'до посёлка Козыревск 500 км по дороге, дальше около 70 км лесной дороги до кордона «Клешня»',
    time: 'до Козыревска на машине или рейсовом автобусе 8–9 часов, от Козыревска до кордона «Клешня» на машине повышенной проходимости 4–5 часов',
    sources: ['https://www.vulcanikamchatki.ru/files/pasporta_2024/2_pasport_voshozhdenie_na_ploskij_tolbachik.pdf'],
  },
  {
    place: 'Курильское озеро',
    match: /курильск(?:ое|ого|ом|ому)\s+озер/i,
    distance: 'вертолётом около 200–220 км',
    time: 'перелёт вертолётом из Елизово около 1 ч 15 мин – 1 ч 20 мин (по программам операторов)',
    sources: [
      'https://tokamchatka.ru/tour33.shtm',
      'https://kamchatkatravel.net/tur-na-kurilskoe-ozero',
      'https://kam-travel.ru/vertolyotnye-ekskursii/kurilskoe-ozero-individualnyj/',
    ],
  },
];

/** Блок фактов дороги для мест, названных в вопросе. Нет мест — пусто. */
export function travelFactsBlock(question: string): string {
  const hits = TRAVEL_FACTS.filter((f) => f.match.test(question));
  if (!hits.length) return '';
  const lines = hits.map((f) => {
    const parts = [f.distance && `расстояние: ${f.distance}`, f.time && `время в пути: ${f.time}`].filter(Boolean);
    const noTime = f.time ? '' : '; времени в пути в данных нет — его подтвердит оператор/перевозчик';
    return `- ${f.place}: ${parts.join('; ')}${noTime} (источник: ${f.sources.join(', ')})`;
  });
  return `ДОРОГА ИЗ ПЕТРОПАВЛОВСКА-КАМЧАТСКОГО (проверенные данные с источником):\n${lines.join('\n')}`;
}
