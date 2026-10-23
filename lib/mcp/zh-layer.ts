/**
 * Китайский слой для агентов — один текст на три поверхности обнаружения.
 *
 * Решение владельца 12.10 («го» на вопрос «как нам сделать, чтоб китайские
 * модели знали о нас»). В веса модели не записаться; управляем тем, что модель
 * видит в момент ответа: китайские чаты (DeepSeek, Qwen/通义, Doubao, Kimi,
 * 文心) отвечают с поиском, поисковики у них свои (Baidu, Bing, Sogou, Shenma,
 * Toutiao), а турист спрашивает по-китайски — «堪察加». До этого дня ни одной
 * китайской строки на платформе не было: индексировать русскую страницу под
 * китайский запрос поисковику нечем.
 *
 * Текст один и живёт здесь, потому что читают его три поверхности — llms.txt,
 * манифест /.well-known/mcp.json (и страница /mcp) и визитка A2A — и три
 * копии разошлись бы (§12 CLAUDE.md: правило, написанное трижды, — три
 * правила). Описания ИНСТРУМЕНТОВ не трогаются: там английская фраза плюс
 * русское описание Кузьмича символ в символ (сторож mcp-tool-descriptions-en),
 * и модели читают английский.
 *
 * Факты — только те, что уже стоят в llms.txt и реестре инструментов: ничего
 * про платформу, чего нет в коде, здесь не утверждается. Данные платформы
 * русские, и это сказано прямо: обещать китайский поиск по турам было бы
 * выдумкой (§4.0).
 *
 * Сторож: tests/unit/agents-china-layer.test.ts.
 */

import { MCP_CONNECT_OPTIONS, MCP_ENDPOINT, MCP_SERVER_KEY, type McpConnectOption } from '@/lib/mcp/connect';

/** Заголовок: латинское имя, транслитерация и «Камчатка» иероглифами — так ищут. */
export const MCP_TITLE_ZH = 'Vedar（维达尔）— 堪察加旅游平台';

/** Описание сервера — манифест, страница /mcp. */
export const MCP_DESCRIPTION_ZH =
  'Vedar（vedarai.ru，俄文名 Ведар）是俄罗斯堪察加半岛的旅游平台，向 AI 代理开放 MCP 服务器与 A2A 接口：'
  + '本地旅行社的团队游及其真实余位、地点与路线的安全信息和当前状况（火山、地震、天气预警）、住宿、装备租赁、接送、天气、行程规划。'
  + '写操作只有四种申请（选团 create_lead、指定团和日期的预订申请 create_booking_request、住宿申请 create_stay_request、包车申请 request_charter），'
  + '均由人工确认，无在线支付，无需认证，按 IP 限流。平台数据为俄文，工具参数以俄文或英文为佳。堪察加紧急电话：112。';

/** Хвост описания агента A2A — та же суть, короче. */
export const A2A_DESCRIPTION_ZH =
  '中文: Vedar 堪察加旅游代理——团队游与真实余位、安全预警、地点、天气、住宿、行程规划。'
  + '支持自由文本提问（俄文或英文为佳）或通过 DataPart {"tool", "arguments"} 精确调用工具；'
  + '四种申请均由人工确认，无支付，无需认证。';

/** Пример вопроса для навыка разговора: агент, выбирающий навык по словам, узнаёт китайский запрос. */
export const A2A_CHAT_EXAMPLE_ZH = '八月去堪察加，哪里能看到棕熊？现在那里安全吗？';

/**
 * «Как подключить в китайском клиенте» (аудит 15.10, CN-zh). До этого /zh,
 * README и llms.txt называли только адрес и общий JSON: человеку в 豆包 или
 * 扣子 оставалось самому угадать, куда его вставить. Здесь — шаги под каждый
 * клиент, у которого в разведке 15.10 есть источник; без источника клиента
 * в списке нет.
 *
 * Живого подключения ни в одном из них не было — поэтому у каждой записи
 * источник, дата, когда он прочитан, и пометка «据…整理，界面可能不同»:
 * объявленный путь без проверки называется так вслух (§10.09 CLAUDE.md).
 * Адрес в шагах — из MCP_ENDPOINT, ссылки Trae — из lib/mcp/connect: второго
 * адреса и второй схемы ссылки здесь нет.
 *
 * Сторож: tests/unit/zh-connect-guides.test.tsx (рендер /zh).
 */
export interface ZhClientGuide {
  /** Устойчивый ключ для разметки и сторожа. */
  id: 'doubao_desktop' | 'coze' | 'cherry_studio' | 'qoder_cn' | 'step_code' | 'trae' | 'qwen_desktop' | 'kimi_code' | 'glm_api';
  /** Клиент, как его называет человек. */
  client: string;
  /** Шаги по-китайски; адрес сервера — в шагах, в коде или в окне подтверждения. */
  steps: readonly string[];
  /** Что вставить или выполнить — команда или JSON; null — всё в шагах. */
  code: string | null;
  /** Ссылки-установки из lib/mcp/connect: подпись по-китайски и адрес. */
  links: readonly { id: McpConnectOption['id']; label: string; href: string }[];
  /** Ограничения клиента словами площадки; null — не названы. */
  caveat: string | null;
  /** Откуда шаги: документация самой площадки или сторонний гид. */
  basis: 'platform_docs' | 'third_party';
  /** Где прочитано: адрес и, если есть, дата самого материала. */
  sources: readonly { url: string; published: string | null }[];
  /** Когда источник прочитан (разведка 15.10). */
  checkedOn: string;
}

/** Пометка по роду источника: живой проверки не было ни у одной записи. */
export const ZH_GUIDE_BASIS_NOTE: Record<ZhClientGuide['basis'], string> = {
  platform_docs: '据平台文档整理，界面可能不同',
  third_party: '据第三方指南整理，界面可能不同',
};

function connectLink(id: McpConnectOption['id'], label: string): ZhClientGuide['links'][number] {
  const option = MCP_CONNECT_OPTIONS.find((o) => o.id === id && o.kind === 'link');
  // Нет варианта — ошибка сборки, а не кнопка в никуда.
  if (!option) throw new Error(`[zh-layer] нет ссылки подключения ${id} в lib/mcp/connect`);
  return { id, label, href: option.value };
}

const CHECKED_ON = '2026-10-15';
/** Qwen, Kimi Code, GLM — разведка 17.10 (запрос владельца: китайские клиенты). */
const CHECKED_ON_ZH2 = '2026-10-17';

export const ZH_CONNECT = {
  heading: '如何在中文客户端中接入',
  intro: `Vedar MCP 服务器地址：${MCP_ENDPOINT}（Streamable HTTP，无需认证）。以下步骤依据各平台公开资料整理，尚未在这些客户端中实际接入验证。`,
  sourceLabel: '来源',
  checkedLabel: '查阅',
} as const;

export const ZH_CLIENT_GUIDES: readonly ZhClientGuide[] = [
  {
    id: 'doubao_desktop',
    client: '豆包电脑版',
    steps: [
      '打开豆包电脑版，进入「技能 · 连接器 · 伙伴」，点击「新建」→「新建自定义连接器」。',
      `名称填 Vedar，传输类型选 HTTP，服务器 URL 填 ${MCP_ENDPOINT}，自定义 Headers 留空。`,
      '保存后启用该连接器。',
    ],
    code: null,
    links: [],
    caveat: '仅电脑版；企业账号需管理员允许。',
    // Официальной справки на doubao.com разведка 15.10 не нашла.
    basis: 'third_party',
    sources: [
      { url: 'https://open.zhihuiya.com/devportal/integrations/doubao', published: null },
      { url: 'https://apibobo.com', published: '2026-09-14' },
    ],
    checkedOn: CHECKED_ON,
  },
  {
    id: 'coze',
    client: '扣子 3.0',
    steps: [
      '在扣子中打开「扩展」>「MCP」，点击「添加自定义 MCP」。',
      '粘贴下方 JSON（不要添加 type 字段），点击「添加到我的 MCP」。',
      `在「我的 MCP」中把 ${MCP_SERVER_KEY} 添加到 Agent。`,
    ],
    // Поля type в примерах docs.coze.cn нет — и здесь его нет.
    code: JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { url: MCP_ENDPOINT } } }),
    links: [],
    caveat: '仅网页版和桌面版。',
    basis: 'platform_docs',
    sources: [{ url: 'https://docs.coze.cn', published: null }],
    checkedOn: CHECKED_ON,
  },
  {
    id: 'cherry_studio',
    client: 'Cherry Studio',
    steps: [
      '打开「设置」→「MCP」→「MCP 服务器」，点击「添加」。',
      `类型选「可流式传输的 HTTP」，URL 填 ${MCP_ENDPOINT}。`,
    ],
    code: null,
    links: [],
    caveat: null,
    basis: 'platform_docs',
    sources: [{ url: 'https://docs.cherryai.com.cn', published: null }],
    checkedOn: CHECKED_ON,
  },
  {
    id: 'qoder_cn',
    client: 'Qoder CN（原通义灵码）',
    steps: [
      '在 MCP 设置中选择「添加自定义 MCP」。',
      `传输类型选 Streamable HTTP，地址填 ${MCP_ENDPOINT}。`,
    ],
    code: null,
    links: [],
    caveat: 'JetBrains 插件自 2.5.13（2025-06-27）起支持 Streamable HTTP。',
    basis: 'platform_docs',
    sources: [{ url: 'https://docs.qoder.cn/product-overview/changelogs-jetbrains.md', published: null }],
    checkedOn: CHECKED_ON,
  },
  {
    id: 'step_code',
    client: 'Step Code（阶跃星辰）',
    steps: ['在终端运行下方命令。'],
    code: `step mcp add ${MCP_SERVER_KEY} --url ${MCP_ENDPOINT}`,
    links: [],
    caveat: 'Step Code 不支持旧版 SSE 传输；Vedar 使用 Streamable HTTP。',
    basis: 'platform_docs',
    sources: [{ url: 'https://platform.stepfun.com/docs/zh/step-code/customization/mcp', published: null }],
    checkedOn: CHECKED_ON,
  },
  {
    id: 'trae',
    client: 'Trae',
    steps: [
      '点击下方按钮，或把安装链接粘贴到浏览器地址栏后回车。',
      '在浏览器弹窗中确认打开 Trae。',
      `在 Trae 弹出的窗口中核对配置（地址应为 ${MCP_ENDPOINT}），然后确认。`,
    ],
    code: null,
    links: [
      connectLink('trae_cn', '添加到 Trae（中国版）'),
      connectLink('trae', '添加到 Trae 国际版'),
    ],
    caveat: null,
    basis: 'platform_docs',
    sources: [
      { url: 'https://docs.trae.cn/ide_mcp-server-install-links.md', published: null },
      { url: 'https://docs.trae.ai/ide/mcp-server-install-links', published: null },
    ],
    checkedOn: CHECKED_ON,
  },
  {
    id: 'qwen_desktop',
    client: 'Qwen Chat 桌面版（通义千问）',
    steps: [
      '在 Qwen Chat 桌面版（macOS / Windows）的对话框下方点击「MCP」→「MCP 设置」→「添加 MCP」。',
      '选择 JSON 方式，粘贴下方配置并保存，然后启用 vedar。',
    ],
    code: JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { type: 'streamable-http', url: MCP_ENDPOINT } } }),
    links: [],
    caveat: '网页版没有 MCP，仅桌面版；最多同时启用 5 个 MCP 服务器。',
    basis: 'third_party',
    sources: [
      { url: 'https://docs.platform.statista.ai/mcp-server/connection-qwen', published: null },
      { url: 'https://mp.weixin.qq.com/s/7Oee00r7SdRPvt2-HdFqZA', published: null },
    ],
    checkedOn: CHECKED_ON_ZH2,
  },
  {
    id: 'kimi_code',
    client: 'Kimi Code（月之暗面）',
    steps: ['在终端运行下方命令；新会话中即可使用 Vedar 工具。'],
    code: `kimi mcp add --transport http ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`,
    links: [],
    caveat: '适用于 Kimi Code CLI 与 VS Code 插件；kimi.com 网页聊天暂无自定义 MCP 入口。',
    basis: 'platform_docs',
    sources: [{ url: 'https://moonshotai.github.io/kimi-cli/zh/customization/mcp.html', published: null }],
    checkedOn: CHECKED_ON_ZH2,
  },
  {
    id: 'glm_api',
    client: '智谱 GLM API（chat/completions）',
    steps: [
      '在调用 GLM 的 chat/completions 请求中，把下方对象加入 tools 数组，tool_choice 设为 auto。',
      'Vedar 无需认证，不用填写 headers。',
    ],
    code: JSON.stringify({ type: 'mcp', mcp: { server_label: MCP_SERVER_KEY, server_url: MCP_ENDPOINT, transport_type: 'streamable-http' } }),
    links: [],
    caveat: null,
    basis: 'platform_docs',
    sources: [{ url: 'https://docs.z.ai/guides/capabilities/mcp-call', published: null }],
    checkedOn: CHECKED_ON_ZH2,
  },
];

/** Источник одной строкой: адрес, дата материала, если есть, и дата прочтения. */
export function zhGuideSourceLine(g: ZhClientGuide): string {
  const urls = g.sources.map((s) => (s.published ? `${s.url}（${s.published}）` : s.url)).join('、');
  return `${ZH_CONNECT.sourceLabel}：${urls}（${g.checkedOn} ${ZH_CONNECT.checkedLabel}）`;
}

/** Блок для llms.txt: тот же список, по строке на клиент. */
function llmsClientLines(base: string): string[] {
  return [
    `- ${ZH_CONNECT.heading}（详见 ${base}/zh#connect）：${ZH_CONNECT.intro}`,
    ...ZH_CLIENT_GUIDES.map((g) => {
      const parts = [
        g.steps.join(' '),
        g.code ? `\`${g.code}\`` : null,
        g.links.length ? g.links.map((l) => `${l.label}：${l.href}`).join('；') : null,
        g.caveat,
        `${ZH_GUIDE_BASIS_NOTE[g.basis]}。${zhGuideSourceLine(g)}`,
      ].filter(Boolean);
      return `  - ${g.client}：${parts.join(' ')}`;
    }),
  ];
}

/**
 * Раздел llms.txt. Факты о крае — те же, что в русском разделе «ключевые
 * факты» того же файла; ссылки — на те же входы, что и в русских разделах.
 */
export function llmsSectionZh(base: string): string {
  return [
    '## 中文说明（面向中文 AI 助手）',
    '',
    `- 中文版全文：${base}/llms-zh.txt`,
    `- Vedar（${base}，俄文名 Ведар）是堪察加半岛的旅游平台：地点与路线目录、安全信息（火山活动、地震、天气预警）、本地旅行社的团队游及真实余位、住宿、接送、行程规划。`,
    '- 平台内容为俄文；引用时请链接本文件中的页面地址。堪察加：俄罗斯远东半岛，联合国教科文组织世界遗产“堪察加火山群”，300 多座火山（29 座活火山），旅游季 6–9 月，时区 UTC+12。',
    `- AI 代理接口：MCP 服务器 ${base}/api/mcp（JSON-RPC 2.0，Streamable HTTP，无需认证），清单 ${base}/.well-known/mcp.json；A2A 代理卡片 ${base}/.well-known/agent-card.json，JSON-RPC ${base}/api/a2a。`,
    '- 写操作仅限四种申请（create_lead、create_booking_request、create_stay_request、request_charter），均由人工确认；无在线支付。',
    ...llmsClientLines(base),
    '- 紧急情况：堪察加紧急电话 112。',
  ].join('\n');
}

/**
 * Страница /zh — индексируемый HTML по-китайски (карт-бланш владельца 12.10
 * на «подключить китайцев»). Поисковики КНР индексируют HTML, а не llms.txt
 * и не манифест: до этой страницы ни одной китайской страницы у платформы не
 * было, и проба 12.10 показала, что DeepSeek и Qwen о vedarai.ru не знают.
 * Факты — те же, что в разделах выше; ничего, чего нет в коде и llms.txt.
 */
export const ZH_PAGE = {
  /** Заголовок вкладки: латинское имя, иероглифы и что это, в одну строку. */
  title: 'Vedar（维达尔）— 堪察加旅游平台：团队游、安全信息、AI 代理接口',
  /** До 160 знаков — длиннее выдача обрезает. */
  description: '俄罗斯堪察加半岛旅游平台：本地旅行社的团队游及真实余位、火山与地震预警、地点与路线、住宿、租赁、交通、天气；向 AI 代理开放 MCP、A2A 与 OpenAPI 接口。内容为俄文，紧急电话 112。',
  h1: 'Vedar（维达尔）— 堪察加旅游平台',
  langNote: '平台内容为俄文；下列团队游名称保留俄文原文。',
  capabilities: [
    '本地旅行社的团队游及其真实余位（按日期查询）',
    '地点与路线的安全信息和当前状况：火山活动、地震、天气预警',
    '住宿、装备租赁、包车交通、天气预报、行程规划',
  ],
  booking: '预订只有四种申请：选团（create_lead）、指定团和日期的预订申请（create_booking_request）、住宿申请（create_stay_request）、包车申请（request_charter）。均由人工确认；无在线支付，款项直接付给旅行社。',
  agents: 'AI 代理可通过 MCP 服务器（JSON-RPC 2.0，Streamable HTTP，无需认证）、A2A 代理卡或 OpenAPI 3.1 描述接入；工具参数以俄文或英文为佳。',
  emergency: '堪察加紧急电话：112。',
  /** Каталог не прочитан — говорится вслух, а не пустым списком (§4.0). */
  catalogUnavailable: '目录暂时不可用：数据库未响应。请稍后再试，或查看俄文目录。',
  catalogEmpty: '目前没有已发布的团队游。',
} as const;

/**
 * Абзац для info.description OpenAPI: Coze, 百度千帆 и подобные конструкторы
 * читают описания при импорте схемы, и их планировщик выбирает инструмент по
 * словам описания.
 */
export const OPENAPI_DESCRIPTION_ZH =
  '中文：Vedar（维达尔，vedarai.ru）是俄罗斯堪察加半岛旅游平台的公开 API，面向无法使用 MCP 或 A2A 客户端的代理。无需认证；'
  + '写操作仅限四种申请（create_lead、create_booking_request、create_stay_request、request_charter），均由人工确认，无即时预订与支付。'
  + '数据为俄文。堪察加紧急电话 112。';

/**
 * /llms-zh.txt (17.10): отдельный китайский файл для агентов, которые берут
 * файл по языку. Темы — только типы активностей, которые есть в
 * lib/tours/labels (volcano, thermal, bears, …); цены и наличие — живые, в
 * /llms.txt и через MCP, здесь не дублируются (§4.0: без выдуманных цифр).
 */
export const LLMS_ZH_TOPICS: readonly { key: string; zh: string }[] = [
  { key: 'volcano', zh: '火山徒步与登顶' },
  { key: 'thermal', zh: '温泉' },
  { key: 'bears', zh: '观熊（棕熊）' },
  { key: 'helicopter', zh: '直升机游览' },
  { key: 'boat_trip', zh: '海上游船' },
  { key: 'fishing', zh: '钓鱼' },
  { key: 'rafting', zh: '漂流' },
  { key: 'snowmobile', zh: '雪地摩托' },
  { key: 'trekking', zh: '徒步' },
];

export function llmsZhFile(base: string): string {
  return [
    `# ${MCP_TITLE_ZH}`,
    '',
    `> ${MCP_DESCRIPTION_ZH}`,
    '',
    '关键词：堪察加 旅游、堪察加 火山、堪察加 温泉、堪察加 观熊、堪察加 住宿、堪察加 接送、堪察加 包车、堪察加 预订、彼得罗巴甫洛夫斯克-堪察加斯基。',
    '',
    '## 可查询的旅游类型（团队游目录中的活动类型）',
    '',
    ...LLMS_ZH_TOPICS.map((t) => `- ${t.zh}（${t.key}）`),
    '',
    '价格与余位为实时数据，请通过 MCP 工具 get_tours / get_tour_availability 查询，或查看俄文完整版 ' + `${base}/llms.txt。`,
    '',
    '## 如何预订',
    '',
    `- ${ZH_PAGE.booking}`,
    '- 住宿：search_accommodations 查询，create_stay_request 提交住宿申请。',
    '- 接送与包车：search_transfers 查询，request_charter 提交包车申请。',
    '- 租车（无司机，按天计价）：search_car_rental 查询；租车申请在租车公司页面提交，由人工确认。',
    '',
    llmsSectionZh(base),
    '',
    '## 页面',
    '',
    `- 中文主页：${base}/zh`,
    `- MCP 接入说明：${base}/mcp`,
    `- 堪察加编年史（俄文，附出处的历史文章）：${base}/letopis`,
    `- 自然公园与保护区（俄文）：${base}/park/<slug>，列表见 ${base}/llms.txt`,
    `- 俄文完整版：${base}/llms.txt`,
    '',
  ].join('\n');
}
