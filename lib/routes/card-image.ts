/**
 * Что за картинку покажет карточка места — один источник на всех, кто
 * спрашивает.
 *
 * ── Случай 20.09 ───────────────────────────────────────────────────────────
 *
 * Владелец прислал снимок каталога `/places`: на карточках термальных
 * источников стоят кадры с тилингом «alamy» — витринные вотермарк-превью
 * фотобанка, — а у «Голыгинских термальных источников» картинка не источника
 * вовсе: тёмный фон, бирюзовые дуги, оранжевый шар. Вопрос был: «что за фото?»
 *
 * Отвечать пришлось чтением кода, и по дороге выяснилось, что ответ
 * собирается из ТРЁХ мест, ни одно из которых не знает целого:
 *
 *  - `catalog-query` решает, какой адрес положить в карточку;
 *  - `PlaceCard` решает это ЗАНОВО, своим выражением;
 *  - перепись `place-photo-coverage` решала это ТРЕТИЙ раз — и ошиблась.
 *
 * Ошибка переписи записана дословно, потому что она поучительна: место без
 * показываемого снимка она объясняла словами «карточка покажет градиент, и
 * это правда». Градиента там нет. Есть подстановка по категории — кадр с
 * сайта действующего камчатского оператора (`/images/partners/kamchatintour/`),
 * разложенный по родам мест. То есть перепись, заведённая ОТВЕЧАТЬ на вопрос
 * «где фото», сама давала неверный ответ — и давала его уверенно.
 *
 * ── Что здесь есть и чего здесь нет ───────────────────────────────────────
 *
 * Здесь — РОД картинки (откуда она взялась) и её адрес. Здесь НЕТ суждения о
 * правах: вотермарк лежит в пикселях, SQL его не видит, и выдумывать признак
 * «чужое» по роду было бы тем же враньём, что выдуманный рейтинг (§4.0).
 * Про права отвечает человек, глядя на список, который эта функция позволяет
 * собрать честно.
 *
 * ── Почему у мест ветка payload мертва ────────────────────────────────────
 *
 * `pickPayloadImage` разбирает `payload` карточки и принимает ЛЮБОЙ адрес,
 * начинающийся с http/https/«/», — ни хоста, ни прав, ни отношения к месту.
 * Для МЕСТ она при этом не срабатывает никогда: VIEW `agent_route_knowledge`
 * отдаёт местам `'{}'::jsonb` (миграция 942, первая ветка UNION), и разбирать
 * там нечего. Живая она только у маршрутов, где payload — это
 * `kamchatka_routes.metadata`.
 *
 * Это записано здесь, а не выяснено заново, потому что 20.09 я едва не завёл
 * переписи строку «сколько мест показывают картинку из payload». Такая строка
 * вернула бы ноль ПО ПОСТРОЕНИЮ — ровно та тавтология, что жила в счёте гидов
 * (`profile_status = 'active'` при CHECK без такого значения). Замечена она
 * была в тот же день, а исправлена только 25.09 (пакет A): все три копии
 * условия заменены одной — `publicGuideWhere` в lib/guides/visibility.ts.
 * Ноль, который не мог быть другим, — не измерение.
 */

/** Красивые фото-плейсхолдеры по категориям. Кадры оператора, не наши. */
export const CATEGORY_FALLBACK_IMAGES: Record<string, string> = {
  vulkani:              '/images/partners/kamchatintour/volcanoes.webp',
  termalnye_istochniki: '/images/partners/kamchatintour/thermal.jpg',
  geyzery:              '/images/partners/kamchatintour/seo2.jpg',
  morskie_progulki:     '/images/partners/kamchatintour/sea-russkaya.jpg',
  rybalka:              '/images/partners/kamchatintour/rafting.jpg',
  snegohod:             '/images/partners/kamchatintour/snowmobile.jpg',
  vertoletnye_tury:     '/images/partners/kamchatintour/helicopter.jpg',
  dzhip:                '/images/partners/kamchatintour/intro.jpg',
  medvedi:              '/images/partners/kamchatintour/cape.jpg',
  splav:                '/images/partners/kamchatintour/rafting.jpg',
  eco:                  '/images/partners/kamchatintour/seo1.jpg',
  trekking:             '/images/partners/kamchatintour/gorely.jpg',
  lakes:                '/images/partners/kamchatintour/seo4.jpg',
  rivers:               '/images/partners/kamchatintour/rafting.jpg',
  mountains:            '/images/partners/kamchatintour/volcanoes.webp',
};

export function isImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  return v.startsWith('http://') || v.startsWith('https://') || v.startsWith('/');
}

/** Первый годный адрес из payload карточки. У мест payload пуст — см. шапку. */
export function pickPayloadImage(payload: Record<string, unknown>): string | null {
  const arrayCandidates = [payload.photos, payload.images, payload.gallery];
  for (const candidate of arrayCandidates) {
    if (Array.isArray(candidate)) {
      const found = candidate.find(isImageUrl);
      if (found) return found.trim();
    }
  }

  const singleCandidates = [
    payload.image,
    payload.cover_image,
    payload.hero_image,
    payload.tour_image,
  ];
  for (const candidate of singleCandidates) {
    if (isImageUrl(candidate)) return candidate.trim();
  }

  return null;
}

export function categoryFallbackImage(category: string | null): string | null {
  if (!category) return null;
  if (CATEGORY_FALLBACK_IMAGES[category]) return CATEGORY_FALLBACK_IMAGES[category];
  const lower = category.toLowerCase();
  if (lower.includes('вулкан') || lower.includes('volcan')) return CATEGORY_FALLBACK_IMAGES.vulkani;
  if (lower.includes('терм') || lower.includes('thermal') || lower.includes('источник')) return CATEGORY_FALLBACK_IMAGES.termalnye_istochniki;
  if (lower.includes('мор') || lower.includes('sea') || lower.includes('boat')) return CATEGORY_FALLBACK_IMAGES.morskie_progulki;
  if (lower.includes('рыбалк') || lower.includes('fish')) return CATEGORY_FALLBACK_IMAGES.rybalka;
  if (lower.includes('снег') || lower.includes('snow')) return CATEGORY_FALLBACK_IMAGES.snegohod;
  if (lower.includes('вертолёт') || lower.includes('вертол') || lower.includes('helicopter') || lower.includes('heli')) return CATEGORY_FALLBACK_IMAGES.vertoletnye_tury;
  if (lower.includes('медвед') || lower.includes('bear')) return CATEGORY_FALLBACK_IMAGES.medvedi;
  if (lower.includes('сплав') || lower.includes('raft')) return CATEGORY_FALLBACK_IMAGES.splav;
  if (lower.includes('гейзер') || lower.includes('geyser')) return CATEGORY_FALLBACK_IMAGES.geyzery;
  if (lower.includes('озер') || lower.includes('lake')) return CATEGORY_FALLBACK_IMAGES.lakes;
  if (lower.includes('река') || lower.includes('river')) return CATEGORY_FALLBACK_IMAGES.rivers;
  if (lower.includes('гор') || lower.includes('mountain')) return CATEGORY_FALLBACK_IMAGES.mountains;
  return null;
}

/**
 * Род картинки карточки.
 *
 * `own` — снимок этой записи из `ai_route_images`, прошедший правило показа
 * (`SHOWN_MODELS`). Единственный род, про который карточка вправе утверждать,
 * что это снимок ЭТОГО места.
 *
 * `payload_link` — адрес из payload: чужой сервер, прямой хотлинк.
 *
 * `category_fallback` — кадр оператора по роду места. Не это место и не наш
 * снимок; карточка подставляет его молча.
 *
 * `gradient` — картинки нет, рисуется честный градиент по `location_type`.
 */
export type CardImageKind = 'own' | 'payload_link' | 'waypoint_place' | 'category_fallback' | 'gradient';

export interface CardImageInput {
  /** Есть ли у записи снимок, проходящий правило показа. */
  hasShownPhoto: boolean;
  /** id записи — для адреса собственного снимка. */
  id: string;
  payload?: Record<string, unknown> | null;
  category?: string | null;
  /**
   * Род записи. У МЕСТА подстановка по категории не делается — см. ниже.
   * Не передан — считается местом: ошибиться в сторону «не подставлять»
   * дешевле, чем в сторону «подставить чужое».
   */
  kind?: 'place' | 'route' | 'tour' | null;
  /**
   * Только у маршрута: ark_id места — ТОЧКИ ПУТИ (`link_kind = 'waypoint'`),
   * у которого есть показываемый снимок; из точек пути берётся главная —
   * та, чьё имя ближе всего к названию маршрута (catalog-query). Снимок
   * места «рядом» сюда не попадает: он не про этот путь.
   */
  waypointPhotoId?: string | null;
}

export interface CardImage {
  kind: CardImageKind;
  /** null только у `gradient`. */
  url: string | null;
}

export function cardImage(input: CardImageInput): CardImage {
  if (input.hasShownPhoto) {
    return { kind: 'own', url: `/api/images/route/${input.id}` };
  }

  const fromPayload = pickPayloadImage(input.payload ?? {});
  if (fromPayload) return { kind: 'payload_link', url: fromPayload };

  /**
   * ── У МЕСТА подстановки нет (решение владельца 20.09) ────────────────────
   *
   * Перепись с прода в тот день дала число: из 378 живых мест свой снимок
   * есть у 110, а `category_fallback` стоял у 226. То есть у ДВУХ КАРТОЧЕК
   * ИЗ ТРЁХ витрина показывала кадр стороннего оператора как снимок этого
   * места. Не пустоту — чужую картинку, выданную за место.
   *
   * Это та же болезнь, что сочинённые описания того же дня («Каньон
   * Сноубордистов» на реке Половинка под Петропавловском, будучи перевалом
   * над Эссо), только картинкой. И цена та же: платформа, которая обещает не
   * врать, на двух третях карточек показывала не то, что подписано.
   *
   * Владелец выбрал первый из трёх путей — снять подстановку, а не подписать
   * её и не оставить как есть: «витрина побледнеет, зато перестанет врать».
   *
   * МЕСТО — да, МАРШРУТ и ТУР — нет, и это не забывчивость. У места карточка
   * утверждает географический факт: вот это место, вот его снимок. У тура
   * карточка — витрина ПРЕДЛОЖЕНИЯ оператора, и кадр оператора там не
   * подменяет собой объект. Менять их заодно значило бы смешать два решения
   * в одном, а второго владелец не принимал.
   *
   * Род не передан — считается местом: ошибиться в сторону «не подставлять»
   * дешевле, чем в сторону «подставить чужое» (§4.0, умолчание консервативно).
   */
  /**
   * ── У МАРШРУТА — снимок его главной точки пути (решение владельца 26.09) ─
   *
   * Кадр оператора по категории у маршрута показывал чужой объект под именем
   * маршрута: у всей категории `trekking` заглушкой стоял кратер Горелого с
   * бирюзовым озером, и «Однодневный поход к Авачинскому вулкану» выходил на
   * витрину с чужим вулканом (скрин владельца). Та же ложь, что у мест 20.09,
   * только решение тогда касалось мест.
   *
   * Владелец выбрал «фото главной точки маршрута»: настоящий снимок места, к
   * которому ведёт путь. Нет такого снимка — градиент, чужого кадра нет.
   * Тур кадр оператора сохраняет: его карточка — витрина предложения.
   */
  const kind = input.kind ?? 'place';
  if (kind === 'route') {
    if (input.waypointPhotoId) {
      return { kind: 'waypoint_place', url: `/api/images/route/${input.waypointPhotoId}` };
    }
    return { kind: 'gradient', url: null };
  }
  if (kind === 'tour') {
    const fallback = categoryFallbackImage(input.category ?? null);
    if (fallback) return { kind: 'category_fallback', url: fallback };
  }

  return { kind: 'gradient', url: null };
}
