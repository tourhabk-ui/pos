/**
 * Единые публичные профили организации (NAP): подвал и Organization JSON-LD
 * берут ссылки отсюда, чтобы канал в MAX и поддержка не расходились.
 *
 * Канал новостей — t.me/kamchatka_real и max.ru/id4101147649_biz.
 * Поддержка — бот Кузьмича @kuzmichai_bot (решение владельца 17.11);
 * канал старого имени @kamchatourhub сюда не входит. Канала Дзена в
 * репозитории нет — в sameAs его не выдумываем.
 */
export const ORGANIZATION_PROFILES = {
  telegramChannel: 'https://t.me/kamchatka_real',
  telegramSupport: 'https://t.me/kuzmichai_bot',
  maxChannel: 'https://max.ru/id4101147649_biz',
  maxBot: 'https://max.ru/id4101147649_bot',
  github: 'https://github.com/tourhabk-ui/pos',
  mcpExamples: 'https://github.com/tourhabk-ui/vedar-mcp-examples',
  mcpRegistry: 'https://registry.modelcontextprotocol.io/v0.1/servers?search=ru.vedarai%2Fmcp',
} as const;

/** sameAs организации: каналы, репозиторий, реестр MCP и боты Кузьмича. */
export const ORGANIZATION_SAME_AS: readonly string[] = [
  ORGANIZATION_PROFILES.telegramChannel,
  ORGANIZATION_PROFILES.github,
  ORGANIZATION_PROFILES.mcpRegistry,
  ORGANIZATION_PROFILES.mcpExamples,
  ORGANIZATION_PROFILES.telegramSupport,
  ORGANIZATION_PROFILES.maxChannel,
  ORGANIZATION_PROFILES.maxBot,
];
