/**
 * Китайские посадочные для туристов из КНР (Сыщик, 23.11.2026).
 *
 * Только темы, которых ещё нет на /zh и в публикациях Гло как отдельного
 * гида: зимняя Камчатка (вулканы в снегу, океан, термы) и безопасность
 * с регистрацией в МЧС. Безвиз и рейс Харбин уже разобраны на /zh/harbin —
 * новую страницу под тот же запрос не делаем.
 *
 * Факты — из lib/facts/kamchatka, официальных источников и уже опубликованных
 * страниц Ведара. Цен нет. Китайское имя места — рядом с русским, как в
 * lib/zh/place-names. Высоты вулканов — только из справочника KVERT.
 */
import {
  AVACHINSKY_HEIGHT_M,
  CUKS_CONSULT_PHONE,
  CUKS_DUTY_PHONE,
  CUKS_DUTY_RESERVE_PHONE,
  FEDERAL_EMERGENCY_NUMBERS,
  KRONOTSKY_RULES,
  MCHS_REGISTRATION_LEAD,
  MUTNOVSKY_HEIGHT_M,
} from '@/lib/facts/kamchatka';
import { MCHS_LEAD_WORKING_DAYS, MCHS_SOURCE } from '@/lib/safety/mchs-registration';
import { ZH_CONTENT_LANGUAGE, ZH_SAFETY_PATH, ZH_WINTER_PATH } from '@/lib/zh/pages';
import { recordDateIso } from '@/lib/seo/record-modified';
import { faqFromBlocks, parseArticleMarkdown } from '@/lib/articles/markdown';

export const ZH_GUIDE_DATE = '2026-11-23';
export const ZH_GUIDE_AUTHOR = 'Редакция Vedar';
export const KUZMICH_TG = 'https://t.me/kuzmichai_bot';

const MCHS_REG_URL =
  'https://41.mchs.gov.ru/deyatelnost/poleznaya-informaciya/registraciya-turisticheskih-grupp';
const MCHS_BEAR_URL =
  'https://41.mchs.gov.ru/deyatelnost/poleznaya-informaciya/bezopasnost-v-prirodnoy-srede/ostorozhno-buryy-medved-rekomendacii-lyubitelyam-prirody';
const MCHS_WARN_URL =
  'https://41.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/shtormovye-i-ekstrennye-preduprezhdeniya';
const MCHS_112_NEWS_URL = 'https://41.mchs.gov.ru/deyatelnost/press-centr/novosti/5849794';
const KVERT_URL = 'http://kvert.febras.net/';
const KVERT_COLORS_URL = 'http://kvert.febras.net/color.php';
const POGODA_PKC_URL = 'https://pogodaiklimat.ru/climate/32583.htm';
const VISIT_SKI_URL = 'https://visitkamchatka.ru/activities/gornye-lyzhi-i-snoubord/';
const VISIT_THERMAL_URL = 'https://visitkamchatka.ru/activities/termalnye-istochniki/';
const VISIT_SURF_URL = 'https://visitkamchatka.ru/activities/serfing-kruglyy-god/';
const VISIT_FAQ_URL = 'https://visitkamchatka.ru/faq/';
const KAM24_WINTER_URL = 'https://kam24.ru/news/main/20261108/133985.html';
const KRONOKI_RULES_URL = KRONOTSKY_RULES.sourceUrl;
const KRONOKI_BEAR_URL = 'https://kronoki.ru/ru/visit/information-for-all/rules/430.html';
const KRONOKI_PREP_URL = 'https://kronoki.ru/ru/visit/information-for-all/preparing-for-travel/';
const COMMANDER_URL = 'https://commanderislands.ru/puteshestvennikam/';

export type ZhGuideLink = { href: string; label: string };
export type ZhGuideSource = { href: string; label: string };
export type ZhGuideFaq = { question: string; answer: string };
export type ZhGuideSection = {
  id: string;
  heading: string;
  paragraphs: readonly string[];
  links?: readonly ZhGuideLink[];
  bullets?: readonly string[];
};

export type ZhGuide = {
  slug: string;
  path: string;
  title: string;
  description: string;
  h1: string;
  date: string;
  lead: string;
  /** Живой блок сразу после лида (на /zh/safety — ссылка на радар). */
  live?: { heading: string; text: string; href: string; cta: string; note: string };
  sections: readonly ZhGuideSection[];
  faqHeading: string;
  faq: readonly ZhGuideFaq[];
  relatedHeading: string;
  related: readonly ZhGuideLink[];
  sourcesHeading: string;
  sources: readonly ZhGuideSource[];
  /** Русский аналог для hreflang; нет точной пары — null. */
  ruPath: string | null;
};

const [EMERGENCY_112, EMERGENCY_101, EMERGENCY_102, EMERGENCY_103] = FEDERAL_EMERGENCY_NUMBERS.value;

export const ZH_WINTER_GUIDE: ZhGuide = {
  slug: 'kamchatka-zimoj',
  path: ZH_WINTER_PATH,
  title: '冬季去堪察加看什么：雪山火山、海洋和温泉｜Vedar 堪察加',
  description:
    '冬季堪察加可以看积雪覆盖的火山、太平洋海岸，并在温泉浸泡。气温、活动类型和注意事项均附官方来源。',
  h1: '冬季的堪察加：雪山火山、海洋和温泉',
  date: ZH_GUIDE_DATE,
  lead:
    '冬季的堪察加（Камчатка）是另一种行程：可以看到积雪覆盖的火山、太平洋（Тихий океан）海岸，并在温泉浸泡。2026年11月8日，地区政府向中国旅客介绍过包含这些内容的冬季线路。气温以彼得罗巴甫洛夫斯克-堪察加斯基（Петропавловск-Камчатский）的气象记录为准，具体出发取决于天气和运营方确认。',
  sections: [
    {
      id: 'weather',
      heading: '冬季的堪察加是什么样的天气？',
      paragraphs: [
        `十一月在彼得罗巴甫洛夫斯克-堪察加斯基（Петропавловск-Камчатский）已是入冬过渡：气象站32583的多年平均气温为 −0,6 °C。十二月进入稳定冬季，平均气温 −5 °C；一月为 −6,5 °C，二月约为 −6,1 °C。`,
        '地区旅游门户把十二月和一月归为滑雪、雪地摩托、狗拉雪橇、冰钓和冲浪的季节；二月和三月还提到雪地摩托、履带车和直升机的自由滑行，以及冬季海上游览。新年在俄罗斯各地之中，堪察加最先迎来。',
      ],
      links: [
        { href: '/kamchatka-v-noyabre', label: '俄文页：十一月的堪察加' },
        { href: '/kamchatka-v-dekabre', label: '俄文页：十二月的堪察加' },
        { href: '/kamchatka-v-yanvare', label: '俄文页：一月的堪察加' },
        { href: '/kamchatka-v-fevrale', label: '俄文页：二月的堪察加' },
        { href: '/kogda-ehat-na-kamchatku', label: '俄文页：何时去堪察加' },
      ],
    },
    {
      id: 'volcanoes',
      heading: '冬天能看到哪些火山？',
      paragraphs: [
        `城市附近的「家门口火山」冬天仍在视野里。阿瓦恰火山（Авачинский вулкан）海拔 ${AVACHINSKY_HEIGHT_M.value} 米，穆特诺夫斯基火山（Мутновский）海拔 ${MUTNOVSKY_HEIGHT_M.value} 米，高度均按 KVERT（远东分院火山学与地震学研究所）目录。积雪覆盖的火山是地区向中国旅客介绍的冬季线路中的核心景观之一。`,
        '登山季节与冬季观赏不是一回事。有向导的登顶通常安排在夏季；冬季更多是远眺、乘雪地摩托前往山口，或在有运营方组织时滑雪。某座火山当天能否靠近，要看 KVERT 的航空颜色代码和紧急情况部的预警，不能把「看得到」理解成「可以登顶」。',
      ],
      links: [
        { href: '/zh/volcano-tours', label: '中文：堪察加火山旅游' },
        { href: '/zh/safety', label: '中文：安全与登记' },
        { href: '/voshozhdeniya-na-vulkany-kamchatki', label: '俄文页：火山登顶' },
      ],
    },
    {
      id: 'ocean',
      heading: '冬天可以去看海吗？',
      paragraphs: [
        '可以看海，但不适合在彼得罗巴甫洛夫斯克-堪察加斯基附近下海游泳。地区门户把冬季海上游览列入二月至三月的活动，并向中国旅客介绍的冬季线路也提到太平洋。哈拉克特尔海滩（Халактырский пляж）被地区门户写成可以全年冲浪；这是专业运动，不是海水浴。',
        '出海能否成行取决于海况和天气，出发前向运营方确认。',
      ],
      links: [
        { href: '/morskie-progulki-kamchatka', label: '俄文页：海上游览' },
        { href: '/places/halaktyrskij-plyazh', label: '俄文页：哈拉克特尔海滩' },
      ],
    },
    {
      id: 'thermals',
      heading: '哪里可以泡温泉？',
      paragraphs: [
        '温泉是冬季行程里较少受降雪影响的部分。帕拉通卡（Паратунка）是巴尔涅奥洛吉疗养区，沿路约三十公里分布着疗养院和度假基地，多有露天温水池。地区门户写道，多数露天水池全年开放；从彼得罗巴甫洛夫斯克-堪察加斯基沿公路大约五十分钟。',
        '不是每一处水池都对非住客全天开放，抵达前向具体基地确认开放时间。海边的海水不能代替温泉。',
      ],
      links: [
        { href: '/paratunka', label: '俄文页：帕拉通卡' },
        { href: '/zh/places/zelenovskie-ozerki', label: '中文地点页：泽列诺夫斯基湖' },
      ],
    },
    {
      id: 'activities',
      heading: '冬季还有哪些典型活动？',
      paragraphs: [
        '除了看火山、看海和泡温泉，地区门户还把滑雪、雪地摩托、狗拉雪橇和冰钓列为十二月至一月的常见项目。导游材料里常提到的滑雪场包括叶利佐沃（Елизово）附近的「Морозная」，以及市内的「Красная сопка」「Эдельвейс」和「Кирпичики」；旺季多在一月至三月。公园酒店「Снежная Долина」公布的 2027 年直升机滑雪季节是一月至五月。',
        '目录里有冬季冰钓和新年假期行程的中文摘要页。摘要页不接受预订，申请请在对应的俄文线路页提交；申请不等于预订，出发日期由运营方确认。本页不列价格。',
      ],
      links: [
        { href: '/zh/catalog', label: '中文团队游目录' },
        { href: '/zh/tours/zimnyaya-rybalka-noyabr-yanvar', label: '中文摘要：十一月至一月冰钓' },
        { href: '/zh/tours/lagexp-novyj-god-na-kamchatke', label: '中文摘要：新年行程' },
        { href: '/gornolyzhnye-bazy-kamchatki', label: '俄文页：滑雪场' },
        { href: '/snegohodnye-tury-kamchatka', label: '俄文页：雪地摩托' },
      ],
    },
    {
      id: 'plan',
      heading: '怎样安排行程并查看安全状况？',
      paragraphs: [
        '从中国出发，先看中文页「从哈尔滨飞往堪察加」：那里说明了伊尔航空的周六直飞，以及持普通护照的中华人民共和国公民免签停留规则。不要把免签理解成可以进入所有区域：需要特别许可的地方仍要办许可。',
        '出发前查看实时安全雷达，并了解如何在俄罗斯紧急情况部（МЧС）登记路线。关于当前预警、登记期限和遇险电话，见本站中文安全页。有具体问题可以问库兹米奇（Кузьмич），他是 Vedar 的人工智能助手，按平台已核实的资料回答。',
      ],
      links: [
        { href: '/zh/harbin', label: '从哈尔滨飞往堪察加' },
        { href: '/zh/safety', label: '中文：安全与登记' },
        { href: '/safety', label: '俄文实时雷达' },
        { href: KUZMICH_TG, label: '在 Telegram 向库兹米奇提问' },
      ],
    },
  ],
  faqHeading: '常见问题',
  faq: [
    {
      question: '冬季去堪察加适合看什么？',
      answer:
        '可以看到积雪覆盖的火山、太平洋海岸，并在温泉浸泡。地区门户还把滑雪、雪地摩托、狗拉雪橇和冰钓列为十二月至一月的常见项目。具体出发取决于天气和运营方确认。',
    },
    {
      question: '彼得罗巴甫洛夫斯克冬天有多冷？',
      answer:
        '按气象站 32583 的多年平均：十一月 −0,6 °C，十二月 −5 °C，一月 −6,5 °C，二月约 −6,1 °C。这是平均值，出发当天的气温以预报为准。',
    },
    {
      question: '冬天能不能登阿瓦恰火山？',
      answer:
        `阿瓦恰火山海拔 ${AVACHINSKY_HEIGHT_M.value} 米，冬天可以远眺积雪覆盖的山体。有向导的登顶通常安排在夏季。能否靠近一座火山，要看当天的 KVERT 代码和紧急情况部预警。`,
    },
    {
      question: '从中国怎么到冬季的堪察加？',
      answer:
        '先看中文页「从哈尔滨飞往堪察加」：那里有周六直飞和免签说明。本页只谈冬季在当地看什么，不重复入境规则。',
    },
  ],
  relatedHeading: '延伸阅读',
  related: [
    { href: '/zh/safety', label: '去堪察加安全吗' },
    { href: '/zh/harbin', label: '从哈尔滨飞往堪察加' },
    { href: '/zh/catalog', label: '中文团队游目录' },
    { href: '/zh/volcano-tours', label: '堪察加火山旅游' },
    { href: '/kogda-ehat-na-kamchatku', label: '俄文：何时去堪察加' },
  ],
  sourcesHeading: '来源',
  sources: [
    { href: KAM24_WINTER_URL, label: 'ИА «Кам 24」，「堪察加向中国旅客介绍冬季线路」（2026-11-08）' },
    { href: POGODA_PKC_URL, label: '「Погода и климат」，彼得罗巴甫洛夫斯克-堪察加斯基气候表，气象站 32583' },
    { href: VISIT_SKI_URL, label: 'Visit Kamchatka，「高山滑雪和单板滑雪」' },
    { href: VISIT_SURF_URL, label: 'Visit Kamchatka，「全年冲浪」' },
    { href: VISIT_THERMAL_URL, label: 'Visit Kamchatka，「温泉」' },
    { href: AVACHINSKY_HEIGHT_M.sourceUrl!, label: AVACHINSKY_HEIGHT_M.sourceLabel },
    { href: MUTNOVSKY_HEIGHT_M.sourceUrl!, label: MUTNOVSKY_HEIGHT_M.sourceLabel },
    { href: 'https://vedarai.ru/kamchatka-v-dekabre', label: 'Ведар，十二月的堪察加' },
    { href: 'https://vedarai.ru/kogda-ehat-na-kamchatku', label: 'Ведар，何时去堪察加' },
    { href: 'https://vedarai.ru/paratunka', label: 'Ведар，帕拉通卡' },
    { href: 'https://vedarai.ru/gornolyzhnye-bazy-kamchatki', label: 'Ведар，滑雪场' },
    { href: 'https://vedarai.ru/zh/harbin', label: 'Vedar，从哈尔滨飞往堪察加' },
  ],
  ruPath: null, // /articles/zima — не пара: там цены каталога, здесь гид без цен
};

export const ZH_SAFETY_GUIDE: ZhGuide = {
  slug: 'safety',
  path: ZH_SAFETY_PATH,
  title: '去堪察加安全吗，如何降低风险｜Vedar 堪察加',
  description:
    '去堪察加可以成行，但需考虑熊、天气、火山、水域和通讯。如何在紧急情况部登记路线、查看预警并在遇险时求助。',
  h1: '去堪察加安全吗',
  date: ZH_GUIDE_DATE,
  lead:
    '如果事先查看预警、按规定在俄罗斯紧急情况部（МЧС）登记路线，并知道遇险时拨打哪个电话，就可以前往堪察加（Камчатка）。需要考虑的风险包括熊、天气、火山、水域和通讯。',
  live: {
    heading: '现在的安全局势在哪里看？',
    text:
      '实时雷达、预警和火山代码在俄文页 /safety 自动更新。该页的界面目前是俄文；把雷达做成中文是另一项工作。请把雷达放在出发前必看的位置，不要只读下面的说明文字。',
    href: '/safety',
    cta: '打开实时雷达（俄文）',
    note: '雷达和预警会随情况变化。下面的说明讲的是一般规则，不能代替当天的预警。',
  },
  sections: [
    {
      id: 'mchs',
      heading: '出发前为什么要在紧急情况部（МЧС）登记路线？',
      paragraphs: [
        `按俄罗斯紧急情况部 2023 年 3 月 29 日第 ${MCHS_REGISTRATION_LEAD.order} 号命令，游览路线须在开始前 ${MCHS_LEAD_WORKING_DAYS} 个工作日提交通知，不是出发前一天。工作日与日历日不同：星期五提交、十天后出发，间隔往往不够十个工作日。`,
        `可以在紧急情况部网站在线填写，也可以邮寄或本人到堪察加边疆区紧急情况总局危机管理中心（ЦУКС）提交。地址和渠道以总局页面和 ${MCHS_SOURCE.asOf} 的备忘录为准。路线结束后要打电话给危机管理中心，请他们撤销对团队的监控；不打电话，有可能被当成尚未返回并启动搜寻。`,
        `填写路线单和预警咨询电话是 ${CUKS_CONSULT_PHONE.value}。值班电话是 ${CUKS_DUTY_PHONE.value}，备用 ${CUKS_DUTY_RESERVE_PHONE.value}。`,
      ],
      bullets: [
        '网上：在俄罗斯紧急情况部官方网站提交申请。',
        '邮寄：挂号信并要求回执，寄至 683003, Камчатский край, г. Петропавловск-Камчатский, ул. Ленинградская, д. 25。路线单和个人数据同意书表格在边疆区紧急情况总局网站「旅游团队登记」栏目。',
        '本人前往：边疆区紧急情况总局危机管理中心（ЦУКС），地址 г. Петропавловск-Камчатский, ул. Тундровая, д. 6。',
      ],
      links: [
        { href: MCHS_REGISTRATION_LEAD.formUrl, label: '紧急情况部在线登记表' },
        { href: MCHS_REG_URL, label: '堪察加紧急情况总局：旅游团队登记' },
        { href: '/kamchatka-samostoyatelno', label: '俄文页：自行前往堪察加' },
      ],
    },
    {
      id: 'parks',
      heading: '间歇泉谷等保护区怎么去？',
      paragraphs: [
        `间歇泉谷（Долина гейзеров）位于克罗诺茨基自然保护区（Кроноцкий заповедник）。按保护区 ${KRONOTSKY_RULES.orderDateLong} 第 ${KRONOTSKY_RULES.order} 号命令的通行规则，访客须由机构工作人员陪同；进入间歇泉谷是参加行程，而不是独自走进去。`,
        '指挥官群岛（Командорские острова）等地也有自己的访问规则，出发前看对应保护地的官方说明。许可和区界以主管部门为准，本页不代替许可。',
      ],
      links: [
        { href: KRONOKI_RULES_URL, label: '克罗诺茨基保护区通行规则' },
        { href: KRONOKI_PREP_URL, label: '克罗诺茨基保护区：出行准备' },
        { href: COMMANDER_URL, label: '指挥官群岛国家公园：给旅行者' },
        { href: '/razreshenie-na-poseshchenie', label: '俄文页：参观许可' },
        { href: '/dolina-gejzerov-kak-popast', label: '俄文页：如何去间歇泉谷' },
      ],
    },
    {
      id: 'bears',
      heading: '在野外怎样避开熊？',
      paragraphs: [
        `棕熊生活在堪察加，紧急情况总局发布过给自然爱好者的建议。在克罗诺茨基保护区和南堪察加禁猎区，观看动物不得近于 ${KRONOTSKY_RULES.animalDistanceM} 米，具体距离由陪同工作人员决定。`,
        '不要把食物留在帐篷外，不要独自离开小组，不要追逐或投喂动物。更完整的说明见俄文页「堪察加的熊」和紧急情况总局的备忘。',
      ],
      links: [
        { href: MCHS_BEAR_URL, label: '紧急情况总局：「小心棕熊！」' },
        { href: KRONOKI_BEAR_URL, label: '克罗诺茨基保护区：安全观熊' },
        { href: '/medvedi-kamchatki', label: '俄文页：堪察加的熊' },
      ],
    },
    {
      id: 'emergency',
      heading: '遇险时拨打什么电话？',
      paragraphs: [
        `统一紧急号码是 ${EMERGENCY_112}。它会转接消防员和救援人员、警察或急救。也可以直接拨打 ${EMERGENCY_101}（消防与救援）、${EMERGENCY_102}（警察）、${EMERGENCY_103}（急救）。`,
        '在没有移动网络的路段，要提前约定通讯方式，并按路线单上的时间与紧急情况部保持联络。地区门户在常见问题中写到，居民点有 4G，偏远路线则不能指望一直有信号。',
      ],
      links: [
        { href: MCHS_112_NEWS_URL, label: '紧急情况总局：关于 112（2026 年团队登记说明）' },
        { href: '/svyaz-i-internet-na-kamchatke', label: '俄文页：通讯和互联网' },
        { href: '/safety/communication', label: '俄文页：途中通讯' },
      ],
    },
    {
      id: 'volcanoes',
      heading: '如何查看火山活动？',
      paragraphs: [
        '火山的航空颜色代码由 KVERT（远东分院火山学与地震学研究所）发布，代码表示火山状态，不等于某一条路线一定可以走。实时页上的雷达会汇总这些代码和紧急情况部的预警。',
        '风暴和紧急预警由堪察加边疆区紧急情况总局公布。出发当天以官方预警为准，而不是以行程表上的计划日期为准。',
      ],
      links: [
        { href: '/safety', label: '实时雷达（俄文）' },
        { href: KVERT_URL, label: 'KVERT 目录' },
        { href: KVERT_COLORS_URL, label: 'KVERT 航空颜色代码' },
        { href: MCHS_WARN_URL, label: '紧急情况总局：风暴和紧急预警' },
        { href: '/vulkany-kamchatki-yunesko', label: '俄文页：堪察加火山' },
      ],
    },
  ],
  faqHeading: '常见问题',
  faq: [
    {
      question: '现在去堪察加安全吗？',
      answer:
        '请先看俄文实时雷达上的当前预警，以及堪察加紧急情况总局发布的紧急预警。熊、天气、火山、水域和通讯是需要考虑的一般风险，降低风险的办法见本页各节。',
    },
    {
      question: '路线要提前多少天向紧急情况部登记？',
      answer: `须在路线开始前 ${MCHS_LEAD_WORKING_DAYS} 个工作日提交，依据是紧急情况部 ${MCHS_REGISTRATION_LEAD.orderDateRu} 第 ${MCHS_REGISTRATION_LEAD.order} 号命令。表格在紧急情况部网站。`,
    },
    {
      question: '能不能自己走进间歇泉谷？',
      answer:
        '不能。在克罗诺茨基保护区的土地上，访客须由机构工作人员陪同；进入间歇泉谷只能参加行程。',
    },
    {
      question: '观看熊要保持多远？',
      answer: `在克罗诺茨基保护区和南堪察加禁猎区，不得近于 ${KRONOTSKY_RULES.animalDistanceM} 米；具体距离由陪同工作人员决定。`,
    },
    {
      question: '需要帮助时拨打什么电话？',
      answer: `拨打统一号码 ${EMERGENCY_112}。它会转接消防员和救援人员、警察或急救。`,
    },
    {
      question: '在哪里看火山活动？',
      answer: '最新的危险等级代码由 KVERT 发布。实时汇总也在俄文页 /safety 的雷达上。',
    },
  ],
  relatedHeading: '延伸阅读',
  related: [
    { href: '/zh/kamchatka-zimoj', label: '冬季的堪察加' },
    { href: '/zh/harbin', label: '从哈尔滨飞往堪察加' },
    { href: '/kamchatka-samostoyatelno', label: '俄文：自行前往堪察加' },
    { href: '/medvedi-kamchatki', label: '俄文：堪察加的熊' },
    { href: '/razreshenie-na-poseshchenie', label: '俄文：参观许可' },
    { href: KUZMICH_TG, label: '向库兹米奇提问' },
  ],
  sourcesHeading: '来源',
  sources: [
    { href: MCHS_REG_URL, label: '俄罗斯紧急情况部堪察加边疆区总局，旅游团队登记' },
    { href: MCHS_SOURCE.memoUrl, label: `${MCHS_SOURCE.authority}，${MCHS_SOURCE.asOf}` },
    { href: MCHS_BEAR_URL, label: '紧急情况总局，「小心棕熊！」' },
    { href: MCHS_WARN_URL, label: '紧急情况总局，风暴和紧急预警' },
    { href: MCHS_112_NEWS_URL, label: '紧急情况总局，2026 年团队登记说明（号码 112）' },
    { href: MCHS_REGISTRATION_LEAD.formUrl, label: '俄罗斯紧急情况部，旅游路线通知表' },
    {
      href: KRONOKI_RULES_URL,
      label: `克罗诺茨基保护区，通行规则（第 ${KRONOTSKY_RULES.order} 号命令，${KRONOTSKY_RULES.orderDateShort}）`,
    },
    { href: KRONOKI_BEAR_URL, label: '克罗诺茨基保护区，安全观熊' },
    { href: KRONOKI_PREP_URL, label: '克罗诺茨基保护区，出行准备' },
    { href: KVERT_URL, label: 'KVERT，远东分院火山学与地震学研究所' },
    { href: KVERT_COLORS_URL, label: 'KVERT，航空颜色代码' },
    { href: VISIT_FAQ_URL, label: 'Visit Kamchatka，常见问题（4G 通讯）' },
    { href: COMMANDER_URL, label: '指挥官群岛国家公园，给旅行者' },
    { href: 'https://vedarai.ru/safety', label: 'Ведар，实时安全页' },
    { href: 'https://vedarai.ru/kamchatka-samostoyatelno', label: 'Ведар，自行前往堪察加' },
  ],
  ruPath: '/safety',
};


/** Видимая дата сверки: 2026年11月23日. */
export function formatZhGuideDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

export function zhGuideHreflang(guide: ZhGuide, site: string): Record<string, string> {
  const root = site.replace(/\/+$/, '');
  const langs: Record<string, string> = {
    'zh-CN': `${root}${guide.path}`,
    'x-default': guide.ruPath ? `${root}${guide.ruPath}` : `${root}${guide.path}`,
  };
  if (guide.ruPath) langs.ru = `${root}${guide.ruPath}`;
  return langs;
}

const SITE_DEFAULT = 'https://vedarai.ru';

export function zhGuideArticleJsonLd(guide: ZhGuide, site = SITE_DEFAULT): Record<string, unknown> {
  const url = `${site}${guide.path}`;
  const published = recordDateIso(guide.date);
  const article: Record<string, unknown> = {
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: guide.h1.length > 110 ? `${guide.h1.slice(0, 109).trimEnd()}…` : guide.h1,
    description: guide.description,
    inLanguage: ZH_CONTENT_LANGUAGE,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    author: { '@type': 'Organization', name: ZH_GUIDE_AUTHOR, url: site },
    publisher: { '@type': 'Organization', '@id': `${site}/#organization`, name: 'Ведар Камчатка', url: site },
    ...(published ? { datePublished: published, dateModified: published } : {}),
  };
  const graph: Record<string, unknown>[] = [article];
  const faq = zhGuideVisibleFaq(guide);
  if (faq.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

export function zhGuideBreadcrumbJsonLd(guide: ZhGuide, site = SITE_DEFAULT): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Vedar 堪察加', item: `${site}/zh` },
      { '@type': 'ListItem', position: 2, name: guide.h1, item: `${site}${guide.path}` },
    ],
  };
}

/**
 * FAQPage только из видимого блока «常见问题». Если текст вопроса или ответа
 * не совпадёт с faq-массивом, тест это поймает.
 */
function zhGuideVisibleFaq(guide: ZhGuide): Array<{ q: string; a: string }> {
  const md = [
    `## ${guide.faqHeading}`,
    ...guide.faq.flatMap((f) => [`**${f.question}**`, f.answer, '']),
  ].join('\n');
  return faqFromBlocks(parseArticleMarkdown(md));
}

export { ZH_CONTENT_LANGUAGE, ZH_SAFETY_PATH, ZH_WINTER_PATH };
