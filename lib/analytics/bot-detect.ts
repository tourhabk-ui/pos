/**
 * Опознание краулера по User-Agent — детерминированно, без сети и эвристик.
 *
 * Зачем: счётчик платформы пишется из браузера (PageViewTracker -> /api/analytics/hit),
 * и до сих пор в нём не было НИКАКОЙ отсечки ботов. Рендереры поисковиков и
 * headless-хром исполняют JS и попадали в «просмотры» наравне с людьми — в
 * источниках переходов это уже видно невооружённым глазом (aisearchindex.space).
 *
 * Бот не выбрасывается, а помечается: доля не-людей — величина, которую надо
 * видеть. Молча выбросить значило бы снова считать вслепую, только в другую
 * сторону.
 *
 * Список сознательно короткий и состоит из подстрок, которые бот сам про себя
 * пишет. Ловить «подозрительное поведение» тут не пытаемся: счётчик посещаемости
 * не место для гадания, а ошибочно помеченный человек хуже пропущенного бота.
 */

/** Подстроки User-Agent (нижний регистр), по которым клиент честно объявляет себя не-человеком. */
const BOT_MARKERS = [
  // Универсальные самоназвания
  'bot', 'crawler', 'spider', 'crawling',
  // Поисковые и соцсетевые рендереры
  'googlebot', 'yandexbot', 'bingbot', 'duckduckbot', 'baiduspider',
  'slurp', 'facebookexternalhit', 'twitterbot', 'telegrambot', 'vkshare',
  'whatsapp', 'skypeuripreview', 'discordbot', 'linkedinbot',
  // AI-краулеры и агрегаторы
  'gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot', 'anthropic-ai',
  'perplexitybot', 'ccbot', 'bytespider', 'amazonbot', 'applebot',
  // Инструменты, мониторинг, headless
  'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'selenium',
  'curl/', 'wget/', 'python-requests', 'httpx', 'go-http-client',
  'axios/', 'node-fetch', 'lighthouse', 'pingdom', 'uptimerobot',
  'ahrefsbot', 'semrushbot', 'mj12bot', 'dotbot', 'petalbot',
];

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true; // безымянный клиент — не браузер человека
  const ua = userAgent.toLowerCase();
  return BOT_MARKERS.some(m => ua.includes(m));
}

/**
 * Свой ли это домен. Реферер с собственного домена — не «источник перехода»,
 * а внутренняя навигация; попав в список внешних, он врёт про приток.
 * tourhab.ru — прежнее имя платформы, оно продолжает приводить людей
 * редиректами, и его переходы тоже наши.
 */
const OWN_HOSTS = ['vedarai.ru', 'tourhab.ru', 'tourhabk.ru', 'localhost'];

export function isOwnReferrer(referrer: string | null | undefined): boolean {
  if (!referrer) return false;
  const r = referrer.toLowerCase();
  return OWN_HOSTS.some(h => r.includes(h));
}
