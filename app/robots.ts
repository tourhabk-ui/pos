import { MetadataRoute } from 'next';

// Публичные хабы — открыты обходу, несмотря на закрытый /hub/*. Индексируется
// из них только /hub/fishing (посадочная «Рыбалка» из шапки сайта);
// /hub/safety — рабочий экран, у него свой noindex, а для поиска есть /safety.
const PUBLIC_HUBS = ['/hub/safety', '/hub/fishing'];

// Входы для агентов. /api/ закрыт целиком и правильно, но MCP-сервер живёт
// именно там: агент, уважающий robots.txt, отказался бы его вызвать. Более
// длинное правило Allow перебивает общий Disallow.
const AGENT_ENTRYPOINTS = ['/api/mcp', '/llms.txt', '/.well-known/mcp.json'];

// Закрыто для ВСЕХ групп одним списком. До 29.09 `/auth/` стоял только в
// группе `*`, а именованные боты (Googlebot, Yandex и ещё 24) читают СВОЮ
// группу и `*` игнорируют: `/auth/login` отвечал им 200 «index, follow».
// `/booking-success/` и `/widget/` не были закрыты нигде (аудит SEO 29.09, Н5).
// Список один — новая группа не может его «забыть».
const DISALLOW = ['/hub/', '/api/', '/.next/', '/auth/', '/booking-success/', '/widget/'];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Общие правила: всё открыто кроме внутренних хабов и API
      {
        userAgent: '*',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
        crawlDelay: 1,
      },

      // Поисковые системы — без ограничений
      {
        userAgent: 'Googlebot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
      // Яндекс — основной бот + все AI-боты (Alice, YandexGPT) содержат подстроку "Yandex"
      {
        userAgent: 'Yandex',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
      {
        userAgent: 'YandexBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
      {
        userAgent: 'YandexImages',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // OpenAI (ChatGPT, GPT-4o browsing, SearchGPT)
      {
        userAgent: 'GPTBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
      {
        userAgent: 'ChatGPT-User',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
      {
        userAgent: 'OAI-SearchBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // Anthropic Claude
      {
        userAgent: 'ClaudeBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
      {
        userAgent: 'Claude-Web',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
      {
        userAgent: 'anthropic-ai',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // Perplexity AI
      {
        userAgent: 'PerplexityBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // Microsoft Copilot / Bing
      {
        userAgent: 'Bingbot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // Google Gemini
      {
        userAgent: 'Google-Extended',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
      {
        userAgent: 'Googlebot-News',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // Apple Siri / Apple Intelligence
      {
        userAgent: 'Applebot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
      {
        userAgent: 'Applebot-Extended',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // Meta AI
      {
        userAgent: 'meta-externalagent',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // You.com
      {
        userAgent: 'YouBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // Cohere
      {
        userAgent: 'cohere-ai',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // DeepSeek AI
      {
        userAgent: 'DeepSeekBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // ByteDance / TikTok AI
      {
        userAgent: 'Bytespider',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // Amazon Alexa / Amazonbot
      {
        userAgent: 'Amazonbot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // DuckDuckGo AI (DuckAssist)
      {
        userAgent: 'DuckAssistBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // AI2 (Allen Institute / OLMo)
      {
        userAgent: 'AI2Bot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // Mistral AI
      {
        userAgent: 'MistralAI-User',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },

      // xAI Grok
      {
        userAgent: 'Grok',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: DISALLOW,
      },
    ],
    sitemap: `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru'}/sitemap.xml`,
    host: (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru').replace('https://', ''),
  };
}
