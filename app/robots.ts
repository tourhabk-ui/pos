import { MetadataRoute } from 'next';

// Публичные хабы — индексируются, несмотря на закрытый /hub/*
const PUBLIC_HUBS = ['/hub/safety', '/hub/fishing'];

// Входы для агентов. /api/ закрыт целиком и правильно, но MCP-сервер живёт
// именно там: агент, уважающий robots.txt, отказался бы его вызвать. Более
// длинное правило Allow перебивает общий Disallow.
const AGENT_ENTRYPOINTS = ['/api/mcp', '/llms.txt', '/.well-known/mcp.json'];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Общие правила: всё открыто кроме внутренних хабов и API
      {
        userAgent: '*',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/', '/.next/', '/auth/'],
        crawlDelay: 1,
      },

      // Поисковые системы — без ограничений
      {
        userAgent: 'Googlebot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
      // Яндекс — основной бот + все AI-боты (Alice, YandexGPT) содержат подстроку "Yandex"
      {
        userAgent: 'Yandex',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
      {
        userAgent: 'YandexBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
      {
        userAgent: 'YandexImages',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // OpenAI (ChatGPT, GPT-4o browsing, SearchGPT)
      {
        userAgent: 'GPTBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
      {
        userAgent: 'ChatGPT-User',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
      {
        userAgent: 'OAI-SearchBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // Anthropic Claude
      {
        userAgent: 'ClaudeBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
      {
        userAgent: 'Claude-Web',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
      {
        userAgent: 'anthropic-ai',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // Perplexity AI
      {
        userAgent: 'PerplexityBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // Microsoft Copilot / Bing
      {
        userAgent: 'Bingbot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // Google Gemini
      {
        userAgent: 'Google-Extended',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
      {
        userAgent: 'Googlebot-News',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // Apple Siri / Apple Intelligence
      {
        userAgent: 'Applebot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
      {
        userAgent: 'Applebot-Extended',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // Meta AI
      {
        userAgent: 'meta-externalagent',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // You.com
      {
        userAgent: 'YouBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // Cohere
      {
        userAgent: 'cohere-ai',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // DeepSeek AI
      {
        userAgent: 'DeepSeekBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // ByteDance / TikTok AI
      {
        userAgent: 'Bytespider',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // Amazon Alexa / Amazonbot
      {
        userAgent: 'Amazonbot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // DuckDuckGo AI (DuckAssist)
      {
        userAgent: 'DuckAssistBot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // AI2 (Allen Institute / OLMo)
      {
        userAgent: 'AI2Bot',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // Mistral AI
      {
        userAgent: 'MistralAI-User',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },

      // xAI Grok
      {
        userAgent: 'Grok',
        allow: ['/', ...PUBLIC_HUBS, ...AGENT_ENTRYPOINTS],
        disallow: ['/hub/', '/api/'],
      },
    ],
    sitemap: `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru'}/sitemap.xml`,
    host: (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru').replace('https://', ''),
  };
}
