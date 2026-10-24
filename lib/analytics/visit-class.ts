/**
 * Кто этот просмотр: человек, бот, ИИ-краулер или свой.
 *
 * Владелец 24.10: в «людях» за сутки оказались автопроверки. Краулер с
 * самоназванием в User-Agent отсекался и раньше (lib/analytics/bot-detect).
 * Не отсекались три других случая, и все три выглядели как Chrome с компьютера,
 * зашедший «напрямую»:
 *
 *  - автоматический браузер (Playwright, Puppeteer, новый headless Chrome)
 *    присылает обычный адрес Chrome, а про себя говорит navigator.webdriver;
 *  - вызов приёма /api/analytics/hit не из клиентского маяка — служебный;
 *  - свой заход: cookie владельца, сессия админа или оператора, адрес
 *    нашего сервера.
 *
 * Сырой User-Agent и адрес наружу и в строку не пишутся. Наружу — метка
 * семейства и четыре исхода.
 */
import { botFamily, isAiFamily, isBotUserAgent } from '@/lib/analytics/bot-detect';

export type VisitAudience = 'person' | 'bot' | 'ai' | 'self';

export interface PageHitSignals {
  userAgent: string | null | undefined;
  /** Маяк прислал navigator.webdriver === true. */
  webdriver: boolean;
  /** Запрос пришёл от PageViewTracker, а не от серверного вызова приёма. */
  clientBeacon: boolean;
  /** Cookie владельца, роль админа/оператора или адрес нашего сервера. */
  own: boolean;
}

export interface PageHitClass {
  isBot: boolean;
  isSelf: boolean;
  /** Метка семейства. Не сырой User-Agent. */
  family: string;
  ai: boolean;
  /**
   * Кого показать. Свой важнее остальных: админ в автоматическом браузере
   * не человек и не «бот с улицы». ИИ — только среди чужих ботов.
   */
  audience: VisitAudience;
}

export function classifyPageHit(s: PageHitSignals): PageHitClass {
  const family = botFamily(s.userAgent);
  const automated = s.webdriver === true || isBotUserAgent(s.userAgent);
  // Нет клиентского маяка — служебный вызов. Это не «не знаем»: приём
  // без маяка сам сказал, что браузер человека страницу не отметил.
  const isBot = s.clientBeacon !== true || automated;
  const isSelf = s.own === true;
  const ai = isBot && isAiFamily(family);
  const audience: VisitAudience = isSelf ? 'self' : ai ? 'ai' : isBot ? 'bot' : 'person';
  return { isBot, isSelf, family, ai, audience };
}
