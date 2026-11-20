/**
 * Поимённые обходчики: прежний htmlLimitedBots next.config.js (до 21.11, когда
 * метаданные стали блокирующими для любого UA). Сторож
 * tests/unit/robots-public-api.test.ts держит здесь каждого бота robots.txt.
 */
export const KNOWN_BOTS = /Googlebot|[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|Bytespider|PetalBot|YisouSpider|360Spider|GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|Claude-User|Claude-SearchBot|anthropic-ai|PerplexityBot|Perplexity-User|meta-externalagent|YouBot|cohere-ai|DeepSeekBot|Amazonbot|DuckAssistBot|AI2Bot|MistralAI-User|Grok|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i;
