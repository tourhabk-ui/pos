import { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';
import { publicApiAllow, publicApiDisallow } from '@/lib/seo/robots-allow';

// Публичные хабы — открыты обходу, несмотря на закрытый /hub/*. Индексируется
// из них только /hub/fishing (посадочная «Рыбалка» из шапки сайта);
// /hub/safety — рабочий экран, у него свой noindex, а для поиска есть /safety.
const PUBLIC_HUBS = ['/hub/safety', '/hub/fishing'];

// Входы для агентов. /api/ закрыт целиком и правильно, но MCP-сервер живёт
// именно там: агент, уважающий robots.txt, отказался бы его вызвать. Более
// длинное правило Allow перебивает общий Disallow.
const AGENT_ENTRYPOINTS = [
  '/api/mcp', '/llms.txt', '/llms-zh.txt', '/llms-en.txt', '/.well-known/mcp.json',
  // A2A (12.10): визитки обеих версий и оба биндинга.
  '/api/a2a', '/.well-known/agent-card.json', '/.well-known/agent.json',
];

// Фото страниц и читающие эндпоинты из openapi.json (аудит 09.11): общий
// Disallow /api/ закрывал og:image 160 страниц и всё, что llms.txt предлагает
// агентам. Список — lib/seo/robots-allow, эндпоинты выводятся из спецификации.
const PUBLIC_API = publicApiAllow();

// Закрыто для ВСЕХ групп одним списком. До 29.09 `/auth/` стоял только в
// группе `*`, а именованные боты (Googlebot, Yandex и ещё 24) читают СВОЮ
// группу и `*` игнорируют: `/auth/login` отвечал им 200 «index, follow».
// `/booking-success/` и `/widget/` не были закрыты нигде (аудит SEO 29.09, Н5).
// Список один — новая группа не может его «забыть».
// Под открытыми путями закрыто то, чего нет в спецификации (10.11): всё глубже
// параметра (`/api/places/<id>/pdf`, `/api/routes/<id>/offline-bundle`) и вход
// партнёров по OAuth под открытым `/api/mcp`.
const DISALLOW = [
  '/hub/', '/api/', '/.next/', '/auth/', '/booking-success/', '/widget/',
  '/api/mcp/partner', ...publicApiDisallow(),
];

export default async function robots(): Promise<MetadataRoute.Robots> {
  // Перепись краулеров по семействам (12.10): robots.txt — первое, что берёт
  // любой обходчик, и единственное место, где видно, приходят ли Baidu,
  // ByteDance и Huawei вообще. headers() делает файл динамическим (он и так
  // собирается из констант); запись не ждётся и ответ не роняет.
  recordAgentEntryHit('/robots.txt', (await headers()).get('user-agent'));
  return {
    rules: [
      // Общие правила: всё открыто кроме внутренних хабов и API
      {
        userAgent: '*',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
        crawlDelay: 1,
      },

      // Поисковые системы — без ограничений
      {
        userAgent: 'Googlebot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      // Яндекс — основной бот + все AI-боты (Alice, YandexGPT) содержат подстроку "Yandex"
      {
        userAgent: 'Yandex',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      {
        userAgent: 'YandexBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      {
        userAgent: 'YandexImages',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // OpenAI (ChatGPT, GPT-4o browsing, SearchGPT)
      {
        userAgent: 'GPTBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      {
        userAgent: 'ChatGPT-User',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      {
        userAgent: 'OAI-SearchBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Anthropic Claude
      {
        userAgent: 'ClaudeBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      {
        userAgent: 'Claude-Web',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      {
        userAgent: 'anthropic-ai',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Perplexity AI
      {
        userAgent: 'PerplexityBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Microsoft Copilot / Bing
      {
        userAgent: 'Bingbot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Google Gemini
      {
        userAgent: 'Google-Extended',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      {
        userAgent: 'Googlebot-News',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Apple Siri / Apple Intelligence
      {
        userAgent: 'Applebot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      {
        userAgent: 'Applebot-Extended',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Meta AI
      {
        userAgent: 'meta-externalagent',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // You.com
      {
        userAgent: 'YouBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Cohere
      {
        userAgent: 'cohere-ai',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // DeepSeek AI
      {
        userAgent: 'DeepSeekBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // ByteDance / TikTok AI
      {
        userAgent: 'Bytespider',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Baidu — главный поисковик КНР; на его индексе стоят и ответы их ИИ
      {
        userAgent: 'Baiduspider',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Huawei — Petal Search (телефоны Huawei без сервисов Google)
      {
        userAgent: 'PetalBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Alibaba — Shenma / Quark (поиск в браузерах UC и Quark; та же группа, что Qwen)
      {
        userAgent: 'YisouSpider',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Tencent — Sogou (поиск внутри WeChat)
      {
        userAgent: 'Sogou web spider',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // 360 Search (so.com)
      {
        userAgent: '360Spider',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      // Пауки картинок и видео 360 — отдельные токены по справке so.com
      // (help_3_2, 15.10; аудит 15.10, CN-detect). Сличает ли 360 группу с
      // токеном целиком (RFC 9309) или по началу, справка не говорит; явные
      // группы снимают вопрос. Правила те же, что у основного паука.
      {
        userAgent: '360Spider-Image',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
      {
        userAgent: '360Spider-Video',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Amazon Alexa / Amazonbot
      {
        userAgent: 'Amazonbot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // DuckDuckGo AI (DuckAssist)
      {
        userAgent: 'DuckAssistBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // AI2 (Allen Institute / OLMo)
      {
        userAgent: 'AI2Bot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // Mistral AI
      {
        userAgent: 'MistralAI-User',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },

      // xAI Grok
      {
        userAgent: 'Grok',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS, ...PUBLIC_API],
        disallow: DISALLOW,
      },
    ],
    sitemap: `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru'}/sitemap.xml`,
    host: (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru').replace('https://', ''),
  };
}
