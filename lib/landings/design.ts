/**
 * Оформление посадочных (ТЗ Сыщика 21.11, design-spec-landings-2026-11-21):
 * главный кадр, фото в тексте и цветные блоки. Текстов здесь нет — только
 * ссылки на уже написанные абзацы (по началу абзаца) и кадры с сайта.
 *
 * Правила кадров (владелец 21.11, «фото партнёров публикуем»):
 *  - только наши адреса: статика /images/…, /api/images/route|place-gallery
 *    (кадры карточек мест) и /api/images/s3/photos/<оператор>/… ;
 *  - подпись автора всегда: «владелец платформы» — у кадров архива сайта и
 *    карточек мест (так их подписывает карточка места), имя оператора со
 *    ссылкой на его страницу — у кадров программ;
 *  - кадр с того же места, что страница; без людей крупным планом, номеров
 *    машин и водяных знаков (кадры просмотрены глазами 21.11: отброшены
 *    рыбаки с рыбой в руках, купальщики, рафты с людьми, «Три брата» с
 *    копирайтом в углу, кит без доказательства, что он у Командор);
 *  - ничего от операторов на паузе (lib/operators/site-pause): у Местечка
 *    кадры не берём, даже если они есть в приложении ТЗ;
 *  - точного кадра нет — герой-градиент (`hero: null`), а не чужой объект.
 *
 * Сторож: tests/unit/landing-design-2111.test.tsx.
 */
import { photoSrc } from '@/lib/images/variant';

export interface LandingPhotoCredit {
  /** Имя в подписи — как его пишет сайт. */
  name: string;
  /** Страница автора (оператора); null — имя текстом. */
  href: string | null;
  /** slug оператора — для проверки паузы; null — архив сайта. */
  operator: string | null;
}

export interface LandingPhoto {
  /** Исходный адрес кадра (ключ манифеста вариантов WebP). */
  src: string;
  /** Что реально на кадре. */
  alt: string;
  /** Подпись: что на кадре и, если надо, чем он не является. */
  caption: string;
  credit: LandingPhotoCredit;
  /** Размер исходника — для width/height (CLS). */
  width: number;
  height: number;
  /** object-position для обрезки в рамку. */
  focus?: string;
}

export interface LandingFigure extends LandingPhoto {
  /** Перед каким разделом (текст заголовка H2, как в статье). */
  beforeH2: string;
}

export type CalloutKind = 'danger' | 'warning' | 'tip';

export interface LandingCallout {
  /** Начало абзаца (простой текст, без сносок) — абзац не меняется. */
  starts: string;
  kind: CalloutKind;
  /** Надпись блока; по умолчанию — по виду. */
  kicker?: string;
}

export interface LandingDesign {
  hero: LandingPhoto | null;
  figures?: LandingFigure[];
  callouts?: LandingCallout[];
}

export const CALLOUT_KICKER: Record<CalloutKind, string> = {
  danger: 'Важно',
  warning: 'Маршрут с ограничениями',
  tip: 'Совет',
};

const OWNER: LandingPhotoCredit = { name: 'владелец платформы', href: null, operator: null };
const KV: LandingPhotoCredit = { name: 'Край Вулканов', href: '/operators/volcanoesland', operator: 'volcanoesland' };
const LAGUNA: LandingPhotoCredit = { name: 'Лагуна Экспедиция', href: '/operators/laguna-expedition', operator: 'laguna-expedition' };

const p = (src: string, alt: string, caption: string, credit: LandingPhotoCredit, width: number, height: number, focus?: string): LandingPhoto =>
  ({ src, alt, caption, credit, width, height, ...(focus ? { focus } : {}) });

const ROAD_WINTER = p('/images/gallery/road-winter.jpg', 'Зимняя дорога среди заснеженного леса, впереди горы', 'Зимняя дорога на Камчатке.', OWNER, 1200, 675);
const SNOWMOBILE = p('/images/activities/snowmobile.jpg', 'Снегоход с санями на заснеженном берегу у океана', 'Снегоход на зимнем берегу.', OWNER, 1280, 594);
const VOLCANOES = p('/images/activities/volcanoes.jpg', 'Конусы вулканов над облаками, над одним — шлейф', 'Вулканы Камчатки.', OWNER, 1170, 749, 'center 40%');
const BEARS = p('/images/hero/bears-kurilskoye.jpg', 'Медведица с медвежатами на берегу озера, за ними вулкан', 'Медведи на Курильском озере.', OWNER, 1152, 718, 'center 70%');
const AURORA = p('/images/gallery/aurora.jpg', 'Северное сияние над силуэтами вулканов', 'Северное сияние над вулканами. Месяц съёмки не указан.', OWNER, 1200, 800);
const STELA = p('/images/gallery/stela.jpg', 'Стела с фигурами медведей, за ней заснеженные вулканы', 'Стела с медведями на фоне вулканов.', OWNER, 1200, 675);
const SEA = p('/images/activities/sea.jpg', 'Сивучи на камнях у моря, за ними горы', 'Сивучи на камнях у побережья.', OWNER, 750, 400);
const CAPE = p('/images/bento/cape.jpg', 'Скалы в прибое на рассвете', 'Скалы в прибое у берега.', OWNER, 1200, 800);
const HELICOPTER = p('/images/activities/helicopter.jpg', 'Вертолёт над заснеженным вулканом', 'Вертолёт над вулканом.', OWNER, 669, 446);
const HERO_MARKET = p('/images/marketplace/hero-marketplace.jpg', 'Заснеженный вулкан над осенней тундрой и камнями', 'Вулканический пейзаж Камчатки.', OWNER, 1280, 854, 'center 35%');
const SUNSET = p('/images/gallery/sunset-clouds.jpg', 'Розовые облака на закате над горами', 'Закатное небо над горами.', OWNER, 1200, 736, 'center 70%');
const KHALAKTYR = p('/images/bento/khalaktyr.jpg', 'Лошадь на чёрном песке у океана', 'Чёрный песок Халактырского пляжа. Это не официальная зона купания.', OWNER, 800, 1733, 'center 55%');
const VACHKAZHETS = p('/images/marketplace/vachkazhets.jpg', 'Озеро на зелёной равнине у скалистых гор со снежниками', 'Горы Вачкажец.', OWNER, 1680, 945);
const GORELY = p('/images/marketplace/gorely_crater.jpg', 'Кратер вулкана с бирюзовым озером и снегом', 'Кратер вулкана Горелый.', OWNER, 1536, 1024);
const VILYUCH = p('/api/images/route/164f612c-32da-4f0f-b261-c45c09dc2933', 'Вулкан Вилючинский со снежной вершиной', 'Вулкан Вилючинский, карточка места на Ведаре.', OWNER, 1280, 720, 'center 30%');
const VILYUCH_2 = p('/api/images/place-gallery/164f612c-32da-4f0f-b261-c45c09dc2933/2', 'Склоны вулкана Вилючинский со снежниками', 'Склоны вулкана Вилючинский со снежниками, карточка места на Ведаре. Снимка самого водопада в каталоге пока нет.', OWNER, 1280, 720);
const AVACHA = p('/api/images/route/3a98a68d-76c8-4835-8d6d-24f7dd867cb8', 'Заснеженный Авачинский вулкан над полем', 'Авачинский вулкан, карточка места на Ведаре.', OWNER, 1280, 720);
const KV_TOLBACHIK = p('/api/images/s3/photos/volcanoesland/ploskiy-tolbachik-04.jpg', 'Красные шлаковые конусы и лавовое поле, вдали путник', 'Шлаковые конусы у Толбачика.', KV, 640, 427);
const KV_TOLBACHIK_CAMP = p('/api/images/s3/photos/volcanoesland/treking-vokrug-ploskogo-tolbachika-01.jpg', 'Палатка и навес у подножия заснеженного вулкана', 'Стоянка у подножия Толбачика.', KV, 640, 427);
const KV_GEYSERS = p('/api/images/s3/photos/volcanoesland/dolina-geyzerov-kaldera-uzon-04.jpg', 'Склоны с выходами пара над рекой', 'Долина гейзеров.', KV, 640, 427);
const KV_GEYSERS_2 = p('/api/images/s3/photos/volcanoesland/dolina-geyzerov-kaldera-uzon-03.jpg', 'Долина реки с паром над склонами', 'Долина гейзеров: пар над склонами долины.', KV, 640, 427);
const KV_KLYUCH = p('/api/images/s3/photos/volcanoesland/treking-podnozhie-klyuchevskoy-01.jpg', 'Заснеженный конус вулкана над тёмными шлаковыми полями', 'Ключевская сопка, вид с подножия.', KV, 640, 360);
const LAGUNA_MALKI = p('/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-cover.jpg', 'Пруд с прозрачной водой среди голых деревьев', 'Малкинские источники, обложка тура.', LAGUNA, 640, 800, 'center 60%');
const LAGUNA_ZELENOVSKIE = p('/api/images/s3/photos/laguna-expedition/zelenovskie-ozerki-cover.jpg', 'Бассейны под открытым небом у домиков, вдали вулкан', 'Зеленовские озерки, обложка тура.', LAGUNA, 640, 478);
const BEARS_2 = p('/images/marketplace/bears_kurilskoye.jpg', 'Два бурых медведя стоят в воде озера', 'Медведи в воде Курильского озера.', OWNER, 550, 605);

const fig = (photo: LandingPhoto, beforeH2: string): LandingFigure => ({ ...photo, beforeH2 });

/** Оформление по slug посадочной. Нет записи — герой-градиент, без блоков. */
export const LANDING_DESIGN: Readonly<Record<string, LandingDesign>> = {
  // Партия 1.
  'kamchatka-v-yanvare': { hero: ROAD_WINTER },
  'kamchatka-v-fevrale': { hero: ROAD_WINTER },
  'kamchatka-v-marte': { hero: SNOWMOBILE },
  'kamchatka-v-aprele': { hero: VOLCANOES },
  'kamchatka-v-mae': { hero: VOLCANOES },
  'kamchatka-v-iyule': { hero: BEARS },
  'kamchatka-v-avguste': { hero: BEARS },
  'kamchatka-v-oktyabre': { hero: null },
  'kamchatka-v-noyabre': {
    hero: ROAD_WINTER,
    callouts: [{ starts: 'Ноябрь — межсезонье: летние маршруты закрыты', kind: 'warning', kicker: 'Маршрут закрыт' }],
  },
  'kamchatka-v-dekabre': { hero: AURORA },
  'kak-dobratsya-na-kamchatku': { hero: STELA },
  'medvedi-kamchatki': {
    hero: BEARS,
    figures: [fig(BEARS_2, 'Когда лучше ехать смотреть медведей?')],
    callouts: [{ starts: 'Не приближайтесь, не убегайте и не поворачивайтесь спиной', kind: 'danger' }],
  },
  'dolina-gejzerov-kak-popast': {
    hero: KV_GEYSERS,
    figures: [fig(KV_GEYSERS_2, 'Как проходит экскурсия в Долину гейзеров?')],
  },
  'morskie-progulki-kamchatka': { hero: SEA },
  'kamchatka-samostoyatelno': {
    hero: null,
    callouts: [{ starts: 'Региональный портал настоятельно рекомендует пользоваться услугами', kind: 'tip' }],
  },
  'kamchatka-s-detmi': { hero: null },
  'chto-posmotret-na-kamchatke': { hero: VOLCANOES },
  'petropavlovsk-za-den': { hero: CAPE },
  // Партия 2.
  'chto-privezti-s-kamchatki': { hero: null },
  'gornolyzhnye-bazy-kamchatki': { hero: null },
  'heli-ski-kamchatka': { hero: HELICOPTER },
  'kamchatskaya-kukhnya-gde-poest': { hero: null },
  'nepogoda-otmenili-vertolet': {
    hero: HELICOPTER,
    callouts: [{ starts: 'Большинство музеев Камчатки работает только по предварительной записи', kind: 'tip' }],
  },
  'novyj-god-na-kamchatke': { hero: AURORA },
  'propusk-ustoj-m-vilyuchinskij-pereval': {
    hero: { ...VILYUCH, caption: 'Вулкан Вилючинский, карточка места на Ведаре. Это не пункт пропуска «Устой-М».' },
    callouts: [
      { starts: 'Порядок может измениться: перед поездкой проверьте', kind: 'tip' },
      { starts: 'По новости сети природных парков «Вулканы Камчатки» от 02.11.2026', kind: 'warning', kicker: 'Маршрут закрыт' },
    ],
  },
  'putevka-na-rybalku-gosuslugi41': { hero: null },
  'stoit-li-ekhat-na-kamchatku': { hero: HERO_MARKET },
  'tolbachik-samostoyatelno': {
    hero: KV_TOLBACHIK,
    figures: [fig(KV_TOLBACHIK_CAMP, 'Когда ехать на Толбачик?')],
    callouts: [{ starts: 'На эту дату маршруты парка «Ключевской» закрыты', kind: 'warning', kicker: 'Маршрут закрыт' }],
  },
  // Партия 3.
  'skolko-dnej-nuzhno-na-kamchatku': { hero: VOLCANOES },
  'pogoda-na-kamchatke-po-mesyacam': { hero: SUNSET },
  'chto-vzyat-s-soboj-na-kamchatku': { hero: null },
  'svyaz-i-internet-na-kamchatke': { hero: null },
  'komandorskie-ostrova-kak-popast': { hero: null },
  'splav-na-kamchatke': { hero: null },
  'vulkany-kamchatki-yunesko': {
    hero: { ...AVACHA, caption: 'Авачинский вулкан, карточка места на Ведаре. Это один из вулканов, а не весь объект ЮНЕСКО.' },
  },
  'mozhno-li-kupatsya-na-kamchatke': {
    hero: KHALAKTYR,
    callouts: [{ starts: 'Не рекомендуется: власти Петропавловска', kind: 'danger' }],
  },
  'raznica-vo-vremeni-kamchatka-moskva': { hero: null },
  'voshozhdenie-na-avachinskij-vulkan': {
    hero: AVACHA,
    callouts: [{ starts: 'Региональный портал называет регистрацию туристического маршрута в МЧС обязательной', kind: 'tip' }],
  },
  // Хабы.
  'kogda-ehat-na-kamchatku': { hero: null },
  'voshozhdeniya-na-vulkany-kamchatki': {
    hero: null,
    callouts: [
      { starts: 'На эту дату летние маршруты парков закрыты на межсезонье', kind: 'warning', kicker: 'Маршрут закрыт' },
      { starts: 'Мутновский закрыт; минтуризма советует не подходить', kind: 'danger' },
    ],
  },
  // Партия 4.
  'serfing-na-kamchatke': {
    hero: { ...KHALAKTYR, caption: 'Чёрный песок Халактырского пляжа.' },
    callouts: [{ starts: 'В 2022 году власти Петропавловска просили не купаться', kind: 'danger' }],
  },
  'sobachi-upryazhki-kamchatka': { hero: null },
  'gonka-beringiya': { hero: null },
  'nalychevo-kak-dobratsya': {
    hero: null,
    callouts: [{ starts: 'На 19 ноября 2026 года — нет', kind: 'warning', kicker: 'Маршрут закрыт' }],
  },
  'vachkazhets-kak-dobratsya': { hero: VACHKAZHETS },
  'malkinskie-istochniki-kak-dobratsya': { hero: LAGUNA_MALKI },
  'zelenovskie-ozerki': { hero: LAGUNA_ZELENOVSKIE },
  // Кадры этого места в приложении ТЗ — только у оператора на паузе.
  'avachinskij-pereval-i-verblyud': {
    hero: null,
    callouts: [
      { starts: 'К перевалу ведёт грунтовая дорога; 19 ноября 2026 года', kind: 'warning' },
      { starts: 'Не пытайтесь объехать размытый участок', kind: 'danger' },
    ],
  },
  'vilyuchinskij-vodopad': {
    hero: { ...VILYUCH, caption: 'Вулкан Вилючинский, карточка места на Ведаре. Водопад — на его северо-западном склоне.' },
    figures: [fig(VILYUCH_2, 'Как добраться?')],
    callouts: [
      { starts: '19 ноября 2026 года Минтуризм края сообщило: проехать от Термального', kind: 'warning' },
      { starts: 'В той же сводке маршруты природного парка «Вилючинский» названы закрытыми', kind: 'warning', kicker: 'Маршрут закрыт' },
    ],
  },
  'voshozhdenie-na-vulkan-gorelyj': { hero: GORELY },
  'klyuchevskaya-sopka-izverzhenie': {
    hero: KV_KLYUCH,
    callouts: [
      { starts: 'Ведомство советовало не приближаться к вулканам', kind: 'danger' },
      { starts: 'Пока маршруты парка закрыты и действует рекомендация не приближаться', kind: 'warning', kicker: 'Маршрут закрыт' },
    ],
  },
  'gde-ostanovitsya-na-kamchatke': { hero: null },
};

export function landingDesign(slug: string): LandingDesign {
  return LANDING_DESIGN[slug] ?? { hero: null };
}

/** Все кадры оформления (герои и фото в тексте) — для сторожа. */
export function allLandingPhotos(): Array<{ slug: string; photo: LandingPhoto }> {
  return Object.entries(LANDING_DESIGN).flatMap(([slug, d]) => [
    ...(d.hero ? [{ slug, photo: d.hero }] : []),
    ...(d.figures ?? []).map((photo) => ({ slug, photo })),
  ]);
}

/** Самый крупный готовый вариант кадра (для og:image и Article.image). */
export function landingOgImagePath(photo: LandingPhoto): string {
  return photoSrc(photo.src, 1280);
}


/**
 * Обложки туров, просмотренные глазами 21.11 (обложка — та же, что в
 * каталоге, lib/tours/hero-image). В список не вошли: люди крупным планом
 * (рыбаки с уловом, группы в лодке и у стола), машины с номерами, тяжёлые
 * исходники без нарезки (0,3–4,7 МБ на карточку ниже складки). Сменил
 * оператор обложку — карточка рисует градиент, пока новую не просмотрят.
 * Туров оператора на паузе здесь нет.
 */
export const REVIEWED_TOUR_COVERS: Readonly<Record<string, string>> = {
  'lagexp-chasovaya-progulka': '/api/images/s3/photos/laguna-expedition/chasovaya-progulka-cover.jpg',
  'lagexp-dukh-kamchatki': '/api/images/s3/photos/laguna-expedition/dukh-kamchatki-cover.jpg',
  'lagexp-k-domashnim-vulkanam-na-vezdekhode-sever-truck': '/api/images/s3/photos/laguna-expedition/k-domashnim-vulkanam-na-vezdekhode-sever-truck-cover.jpg',
  'lagexp-kamchatka-letnij-ekspress': '/api/images/s3/photos/laguna-expedition/kamchatka-letnij-ekspress-cover.jpg',
  'lagexp-kamchatka-na-maksimum-letnij-marshrut': '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-letnij-marshrut-cover.jpg',
  'lagexp-kamchatka-na-maksimum-zimnij-marshrut': '/api/images/s3/photos/laguna-expedition/kamchatka-na-maksimum-zimnij-marshrut-cover.jpg',
  'lagexp-kamchatka-termalnyj-marshrut': '/api/images/s3/photos/laguna-expedition/kamchatka-termalnyj-marshrut-cover.jpg',
  'lagexp-kanon-opasnyj': '/api/images/s3/photos/laguna-expedition/kanon-opasnyj-cover.jpg',
  'lagexp-karymshinskie-termalnye-istochniki': '/api/images/s3/photos/laguna-expedition/karymshinskie-termalnye-istochniki-cover.jpg',
  'lagexp-konnaya-progulka': '/api/images/s3/photos/laguna-expedition/konnaya-progulka-cover.jpg',
  'lagexp-malkinskie-dikie-goryachie-mineralnye-istochniki': '/api/images/s3/photos/laguna-expedition/malkinskie-dikie-goryachie-mineralnye-istochniki-cover.jpg',
  'lagexp-mys-mayachnyj': '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-cover.jpg',
  'lagexp-mys-mayachnyj-khalaktyrskij-plyazh': '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-khalaktyrskij-plyazh-cover.jpg',
  'lagexp-na-kraj-sveta-mys-mayachnyj': '/api/images/s3/photos/laguna-expedition/na-kraj-sveta-mys-mayachnyj-cover.jpg',
  'lagexp-novogodnie-vulkany-kamchatki-laguna-4': '/api/images/s3/photos/laguna-expedition/novogodnie-vulkany-kamchatki-laguna-4-cover.jpg',
  'lagexp-novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki': '/api/images/s3/photos/laguna-expedition/novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki-cover.jpg',
  'lagexp-novyj-god-na-kamchatke': '/api/images/s3/photos/laguna-expedition/novyj-god-na-kamchatke-cover.jpg',
  'lagexp-obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki': '/api/images/s3/photos/laguna-expedition/obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki-cover.jpg',
  'lagexp-obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya': '/api/images/s3/photos/laguna-expedition/obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya-cover.jpg',
  'lagexp-pervyj-rassvet': '/api/images/s3/photos/laguna-expedition/pervyj-rassvet-cover.jpg',
  'lagexp-pogruzhenie-v-kulturu-severa': '/api/images/s3/photos/laguna-expedition/pogruzhenie-v-kulturu-severa-cover.jpg',
  'lagexp-siti-tur-tuda-gde-vstaet-solntse': '/api/images/s3/photos/laguna-expedition/siti-tur-tuda-gde-vstaet-solntse-cover.jpg',
  'lagexp-vulkany-kamchatki-4-dnya': '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-cover.jpg',
  'lagexp-vulkany-kamchatki-4-dnya-novogodnie-prazdniki': '/api/images/s3/photos/laguna-expedition/vulkany-kamchatki-4-dnya-novogodnie-prazdniki-cover.jpg',
  'lagexp-zelenovskie-ozerki': '/api/images/s3/photos/laguna-expedition/zelenovskie-ozerki-cover.jpg',
  'semejnyj-nedelnyj-tur': '/api/images/s3/photos/fishingkam/2025-01-09_114531_1.jpg',
  'splav-bystraya': '/api/images/s3/photos/tours/bystraya-rafting/01-river-volcanoes.jpg',
  'volcanoesland-dolina-geyzerov-kaldera-uzon': '/api/images/s3/photos/volcanoesland/dolina-geyzerov-kaldera-uzon-03.jpg',
  'volcanoesland-kruiz-komandorskie-ostrova': '/api/images/s3/photos/volcanoesland/kruiz-komandorskie-ostrova-04.jpg',
  'volcanoesland-kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha': '/api/images/s3/photos/volcanoesland/kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha-02.jpg',
  'volcanoesland-ploskiy-tolbachik': '/api/images/s3/photos/volcanoesland/ploskiy-tolbachik-01.jpg',
  'volcanoesland-treking-karymskiy-malyy-semyachik-nalychevo': '/api/images/s3/photos/volcanoesland/treking-karymskiy-malyy-semyachik-nalychevo-01.jpg',
  'volcanoesland-treking-podnozhie-klyuchevskoy': '/api/images/s3/photos/volcanoesland/treking-podnozhie-klyuchevskoy-01.jpg',
  'volcanoesland-treking-vokrug-ploskogo-tolbachika': '/api/images/s3/photos/volcanoesland/treking-vokrug-ploskogo-tolbachika-01.jpg',
  'volcanoesland-voskhozhdenie-klyuchevskaya-sopka': '/api/images/s3/photos/volcanoesland/voskhozhdenie-klyuchevskaya-sopka-01.jpg',
  'zaporozhets-kanyon-opasnyy-dachnye': '/api/images/s3/photos/zaporozhets/opasny-canyon-waterfall.jpg',
  'zaporozhets-kurilskoe-ozero-3-dnya': '/api/images/s3/photos/zaporozhets/kurilskoe-bears-river.jpg',
  'zaporozhets-kurilskoe-ozero-4-dnya': '/api/images/s3/photos/zaporozhets/kurilskoe-bears-river.jpg',
  'zaporozhets-tolbachik-4-dnya': '/api/images/s3/photos/zaporozhets/tolbachik-plosky-view.jpg',
  'zaporozhets-vulkan-gorelyy': '/api/images/s3/photos/zaporozhets/gorely-crater-lake.jpg',
};

function sitePath(src: string): string {
  return src.replace(/^https:\/\/(?:www\.)?vedarai\.ru(?=\/)/, '').split(/[?#]/)[0];
}

/** Обложка тура для карточки посадочной: только просмотренная и та же, что сейчас в базе. */
export function reviewedTourCover(slug: string | null | undefined, cover: string | null | undefined): string | null {
  if (!slug || !cover) return null;
  const known = REVIEWED_TOUR_COVERS[slug];
  return known && sitePath(cover) === known ? known : null;
}
