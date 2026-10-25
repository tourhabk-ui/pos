/**
 * Адрес с аномальным числом просмотров за камчатские сутки.
 *
 * Владелец 24.10: подозрение, что трафик суток пришёл с одного адреса.
 * Порог назван явно — больше 30 просмотров с адреса, а в визите ни одного
 * взаимодействия: перехода с другой страницы или времени на странице не
 * меньше ENGAGED_DWELL_MS. Турист, который открыл 31 страницу и на какой-то
 * из них задержался или перешёл дальше, остаётся человеком.
 *
 * Взаимодействие — только то, что браузер не шлёт сам. Время на странице
 * трекер досылает при уходе (pagehide, visibilitychange) на каждом просмотре,
 * и бот, обходящий страницы через page.goto, оставляет его на каждой строке:
 * доли секунды между загрузками. Любое время прежде считалось взаимодействием,
 * и метку получал только бот, не уходивший со страницы штатно (качество 24.10).
 *
 * Взаимодействие засчитывается визиту (sessionId), а не адресу. Человек за
 * общим адресом сотового оператора не снимает метку с бота в соседней вкладке,
 * а доклад времени по чужой строке не возвращает в люди весь адрес.
 * Просмотр без sessionId — визит из одной строки.
 *
 * Адрес нашего сервера сюда не подмешивается как «бот с улицы»: его
 * отмечает isPlatformBoxIp, и строки с is_self эта метка не переписывает.
 * Свои остаются своими.
 *
 * Правило смотрит уже лежащие строки этих суток и решает, что делать
 * с ними. Само по базе не ходит.
 */

/** Строго больше стольких просмотров за сутки — уже не обычный заход. */
export const ADDRESS_BURST_OVER = 30;

/**
 * Время на странице, с которого доклад — чтение, а не след ухода. Пять секунд
 * видимого времени: короче браузер досылает сам, переходя к следующему адресу.
 */
export const ENGAGED_DWELL_MS = 5_000;

export interface AddressBurstInput {
  isBot: boolean;
  isSelf: boolean;
  /** Сколько строк этого адреса уже лежит в текущих камчатских сутках. */
  priorHits: number;
  /**
   * В этом же визите (sessionId) уже был переход или время на странице
   * не меньше ENGAGED_DWELL_MS. Чужие визиты того же адреса не в счёт.
   */
  priorInteraction: boolean;
  fromPath: string | null | undefined;
}

export interface AddressBurstClass {
  isBot: boolean;
  /**
   * Эта строка стала ботом только из-за порога. Тогда время на странице,
   * пришедшее позже, имеет право вернуть её в люди. Уже бот по адресу
   * браузера эту метку не получает — иначе доклад времени снял бы и его.
   */
  anomaly: boolean;
  /**
   * burst — прежние людские строки этого адреса за сутки без взаимодействия
   * в своём визите тоже бот.
   * release — у визита есть взаимодействие, его аномальную метку снять.
   * null — порог не взят и снимать нечего.
   */
  reclass: 'burst' | 'release' | null;
}

function navigated(fromPath: string | null | undefined): boolean {
  return Boolean(fromPath && fromPath.trim());
}

export function classifyAddressBurst(s: AddressBurstInput): AddressBurstClass {
  const moved = navigated(s.fromPath);
  const hits = Number(s.priorHits);
  const over = Number.isFinite(hits) && hits >= 0 && hits + 1 > ADDRESS_BURST_OVER;
  if (over && !s.priorInteraction && !moved) {
    const flip = !s.isSelf && !s.isBot;
    return { isBot: s.isBot || flip, anomaly: flip, reclass: 'burst' };
  }
  if (s.priorInteraction || moved) {
    return { isBot: s.isBot, anomaly: false, reclass: 'release' };
  }
  return { isBot: s.isBot, anomaly: false, reclass: null };
}
