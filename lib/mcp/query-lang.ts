/**
 * Язык запроса к читающим инструментам MCP и перевод ключевых слов в русские.
 *
 * ── Зачем ─────────────────────────────────────────────────────────────
 *
 * Прогон 17.10 (50 туристических вопросов к живому /api/mcp): по-русски 23
 * из 25 верно, по-английски 10 из 15, по-китайски 0 из 10. Данные платформы
 * русские, а справочники мест, туров и прайсы ищутся по русскому названию:
 * «Mutnovsky», «Avacha Bay», «火山», «观熊» давали «нет в справочнике» или
 * пустой список. Агент такое пустое место запоминает как «у Ведара этого нет».
 *
 * ── Что здесь ─────────────────────────────────────────────────────────
 *
 * Закрытый словарь: топонимы Камчатки и слова туриста на английском и
 * китайском → русское название или слово, как оно стоит в данных. Перевод
 * касается ТОЛЬКО аргументов запроса; содержимое базы не переводится (§4.0:
 * машинный перевод описаний туров был бы новыми данными, которых оператор
 * не писал). Чего в словаре нет, остаётся как есть: это «не нашли», а не «нет».
 *
 * Клиент узнаёт, что запрос был не по-русски, из короткой пометки в конце
 * ответа: данные по-русски, переведи человеку сам, не додумывай.
 *
 * Сторож: tests/unit/mcp-query-lang.test.ts.
 */

export type QueryLang = 'ru' | 'en' | 'zh' | 'other';

const HAN = /[\u3400-\u9fff]/;
const CYRILLIC = /[а-яё]/i;
const LATIN = /[a-z]/i;

/** Язык строки по письменности: китайские иероглифы, кириллица, латиница. */
export function detectQueryLang(text: string): QueryLang {
  if (HAN.test(text)) return 'zh';
  if (CYRILLIC.test(text)) return 'ru';
  if (LATIN.test(text)) return 'en';
  return 'other';
}

/**
 * Китайское написание → русское. Иероглифы пробелов не ставят, поэтому
 * замена идёт подстрокой, длинные ключи раньше коротких («间歇泉谷» раньше «温泉»).
 * Топонимы — общепринятые китайские транскрипции; слова — то, как турист
 * спрашивает.
 */
export const ZH_TO_RU: Readonly<Record<string, string>> = {
  // топонимы
  '堪察加半岛': 'Камчатка', '堪察加': 'Камчатка',
  '彼得罗巴甫洛夫斯克': 'Петропавловск-Камчатский', '彼得罗巴甫洛夫斯克-堪察加茨基': 'Петропавловск-Камчатский',
  '穆特诺夫斯基火山': 'Мутновский', '穆特诺夫斯基': 'Мутновский',
  '阿瓦恰火山': 'Авачинский', '阿瓦钦斯基火山': 'Авачинский', '阿瓦钦斯基': 'Авачинский',
  '阿瓦恰湾': 'Авачинская бухта', '阿瓦恰': 'Авача',
  '戈列雷火山': 'Горелый', '戈列雷': 'Горелый', '格列雷': 'Горелый',
  '克柳切夫火山': 'Ключевская', '克柳切夫斯卡亚': 'Ключевская', '克柳切夫': 'Ключевская',
  '托尔巴奇克火山': 'Толбачик', '托尔巴奇克': 'Толбачик',
  '科里亚克火山': 'Корякский', '维柳钦斯基': 'Вилючинский', '希韦卢奇': 'Шивелуч', '卡雷姆斯基': 'Карымский',
  '间歇泉谷': 'Долина гейзеров', '间歇泉山谷': 'Долина гейзеров', '盖泽尔谷': 'Долина гейзеров',
  '库里尔湖': 'Курильское озеро', '千岛湖': 'Курильское озеро',
  '乌宗火山口': 'Узон', '乌宗': 'Узон', '帕拉通卡': 'Паратунка', '哈拉克特尔海滩': 'Халактырский пляж',
  '纳雷切沃': 'Налычево', '埃索': 'Эссо', '指挥官群岛': 'Командорские острова', '贝斯特拉亚河': 'Быстрая',
  // что ищет турист
  '火山': 'вулкан', '观熊': 'медведи', '棕熊': 'медведи', '熊': 'медведи', '钓鱼': 'рыбалка', '海钓': 'рыбалка',
  '温泉': 'термальные источники', '热泉': 'термальные источники', '间歇泉': 'гейзер',
  '直升机': 'вертолёт', '漂流': 'сплав', '徒步': 'трекинг', '登山': 'восхождение', '登顶': 'восхождение',
  '雪地摩托': 'снегоход', '滑雪': 'лыжи', '海滩': 'пляж', '海上游': 'морская прогулка', '游船': 'морская прогулка',
  '鲸': 'киты', '湖': 'озеро', '河': 'река', '湾': 'бухта', '机场': 'аэропорт',
  '住宿': 'жильё', '酒店': 'гостиница', '宾馆': 'гостиница', '民宿': 'гостевой дом', '接送': 'трансфер',
  '帐篷': 'палатка', '睡袋': 'спальник', '天气': 'погода', '旅游': 'тур', '旅行': 'тур', '团': 'тур',
};

/**
 * Английские фразы и слова → русское написание, как в данных. Фразы — для
 * аргументов-названий («Avacha Bay» → «Авачинская бухта»); слова — для
 * свободного текста интересов. Общий поисковый словарь основ для `search`
 * живёт в lib/mcp/search-terms; здесь — целые русские слова, потому что
 * справочники мест и прайсы ищут по названию, а не по основе.
 */
export const EN_TO_RU_NAMES: Readonly<Record<string, string>> = {
  'valley of geysers': 'Долина гейзеров', 'geyser valley': 'Долина гейзеров', 'geysers valley': 'Долина гейзеров',
  'avacha bay': 'Авачинская бухта', 'avachinskaya bay': 'Авачинская бухта',
  'kuril lake': 'Курильское озеро', 'kurile lake': 'Курильское озеро', 'kurilskoye lake': 'Курильское озеро',
  'khalaktyr beach': 'Халактырский пляж', 'khalaktyrsky beach': 'Халактырский пляж',
  'commander islands': 'Командорские острова', 'bystraya river': 'Быстрая',
  'petropavlovsk-kamchatsky': 'Петропавловск-Камчатский', 'petropavlovsk kamchatsky': 'Петропавловск-Камчатский',
  'petropavlovsk': 'Петропавловск-Камчатский', 'kamchatka': 'Камчатка',
  'mutnovsky': 'Мутновский', 'mutnovskiy': 'Мутновский', 'mutnovka': 'Мутновский',
  'avachinsky': 'Авачинский', 'avachinskiy': 'Авачинский', 'avacha': 'Авача',
  'gorely': 'Горелый', 'goreliy': 'Горелый', 'gorelyi': 'Горелый',
  'klyuchevskoy': 'Ключевская', 'klyuchevskaya': 'Ключевская', 'kluchevskoy': 'Ключевская', 'klyuchevskoi': 'Ключевская',
  'tolbachik': 'Толбачик', 'koryaksky': 'Корякский', 'vilyuchinsky': 'Вилючинский', 'shiveluch': 'Шивелуч',
  'karymsky': 'Карымский', 'uzon': 'Узон', 'paratunka': 'Паратунка', 'nalychevo': 'Налычево', 'esso': 'Эссо',
  'yelizovo': 'Елизово', 'elizovo': 'Елизово', 'vachkazhets': 'Вачкажец',
  // интересы и виды отдыха
  'hot springs': 'термальные источники', 'hot spring': 'термальные источники', 'thermal springs': 'термальные источники',
  'bear watching': 'медведи', 'bear viewing': 'медведи', 'bears': 'медведи', 'bear': 'медведи',
  'volcanoes': 'вулканы', 'volcano': 'вулкан', 'fishing': 'рыбалка', 'helicopter': 'вертолёт',
  'rafting': 'сплав', 'hiking': 'трекинг', 'trekking': 'трекинг', 'ascent': 'восхождение', 'climb': 'восхождение',
  'snowmobile': 'снегоход', 'whales': 'киты', 'geysers': 'гейзеры', 'beach': 'пляж', 'airport': 'аэропорт',
  'sleeping bag': 'спальник', 'tent': 'палатка', 'hotel': 'гостиница', 'guesthouse': 'гостевой дом',
};

const ZH_KEYS = Object.keys(ZH_TO_RU).sort((a, b) => b.length - a.length);
const EN_KEYS = Object.keys(EN_TO_RU_NAMES).sort((a, b) => b.length - a.length);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EN_RES = EN_KEYS.map((k) => ({ k, re: new RegExp(`(^|[^a-z])${escapeRe(k)}(?=$|[^a-z])`, 'gi') }));

export interface Localized {
  text: string;
  lang: QueryLang;
  /** Что на что заменено — для пометки клиенту. */
  mapped: Array<{ from: string; to: string }>;
}

/** Перевод одного значения аргумента в русские слова словаря; русское не трогается. */
export function localizeQuery(raw: string): Localized {
  const lang = detectQueryLang(raw);
  const mapped: Localized['mapped'] = [];
  if (lang === 'ru' || lang === 'other') return { text: raw, lang, mapped };
  let text = raw;
  if (lang === 'zh') {
    for (const k of ZH_KEYS) {
      if (text.includes(k)) {
        mapped.push({ from: k, to: ZH_TO_RU[k] });
        text = text.split(k).join(` ${ZH_TO_RU[k]} `);
      }
    }
    // Служебные иероглифы без словарного смысла («的», «有», «什么»…) в русский
    // поиск не идут: остаток китайского текста только портит ILIKE.
    text = text.replace(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]+/g, ' ');
  }
  for (const { k, re } of EN_RES) {
    if (re.test(text)) {
      re.lastIndex = 0;
      mapped.push({ from: k, to: EN_TO_RU_NAMES[k] });
      text = text.replace(re, (_m, pre: string) => `${pre}${EN_TO_RU_NAMES[k]}`);
    }
    re.lastIndex = 0;
  }
  text = text.replace(/\s+/g, ' ').trim();
  // Ничего не узнали — отдаём исходник: пустая строка хуже «не нашли».
  if (!text) return { text: raw, lang, mapped: [] };
  return { text, lang, mapped };
}

/** Поля читающих инструментов, в которых человек называет место, тур или интерес. */
export const LOCALIZABLE_FIELDS: readonly string[] = [
  'query', 'name', 'place', 'zone', 'activity_type', 'volcano', 'tour', 'interests',
];

/** Инструменты, чьи аргументы переводятся. Пишущие сюда не входят: там имя и телефон человека. */
export const LOCALIZABLE_TOOLS: ReadonlySet<string> = new Set([
  'search', 'get_tours', 'get_tour_details', 'get_place_info', 'get_guardian_context', 'get_weather',
  'get_volcano_status', 'search_accommodations', 'search_transfers', 'search_car_rental', 'search_gear', 'make_trip_plan',
  'get_tour_availability',
]);

export interface LocalizedArgs {
  args: Record<string, unknown>;
  lang: QueryLang;
  mapped: Localized['mapped'];
}

/** Аргументы инструмента с переведёнными полями; язык — по первому непустому полю не по-русски. */
export function localizeToolArgs(tool: string, args: Record<string, unknown>): LocalizedArgs {
  if (!LOCALIZABLE_TOOLS.has(tool) || !args || typeof args !== 'object') return { args, lang: 'ru', mapped: [] };
  const out: Record<string, unknown> = { ...args };
  let lang: QueryLang = 'ru';
  const mapped: Localized['mapped'] = [];
  for (const f of LOCALIZABLE_FIELDS) {
    const v = out[f];
    if (typeof v !== 'string' || !v.trim()) continue;
    const l = localizeQuery(v);
    if (l.lang === 'en' || l.lang === 'zh') {
      if (lang === 'ru') lang = l.lang;
      out[f] = l.text;
      mapped.push(...l.mapped);
    }
  }
  return { args: out, lang, mapped };
}

/** Пометка в конце текстового ответа: данные по-русски, перевести человеку — дело клиента. */
export function langNote(lang: QueryLang, mapped: Localized['mapped']): string {
  if (lang !== 'en' && lang !== 'zh') return '';
  const pairs = mapped.slice(0, 8).map((m) => `${m.from} → ${m.to}`).join('; ');
  const head = lang === 'zh' ? 'Query language: Chinese (zh).' : 'Query language: English (en).';
  const how = pairs ? ` Matched to Russian data terms: ${pairs}.` : ' No dictionary match: searched as written.';
  return `\n\n[${head}${how} Platform data is in Russian: translate it for the user yourself; do not add facts that are not in this answer.]`;
}
