/**
 * Адрес с аномальным числом просмотров за камчатские сутки.
 *
 * Владелец 24.10: подозрение, что трафик суток пришёл с одного адреса.
 * Порог назван явно — больше 30 просмотров и ни одного взаимодействия
 * (переход с другой страницы или дописанное время на странице). Турист,
 * который открыл 31 страницу и на какой-то из них задержался или перешёл
 * дальше, остаётся человеком.
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

export interface AddressBurstInput {
  isBot: boolean;
  isSelf: boolean;
  /** Сколько строк этого адреса уже лежит в текущих камчатских сутках. */
  priorHits: number;
  /** Среди них есть переход или время на странице. */
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
   * burst — прежние людские строки этого адреса за сутки тоже бот.
   * release — взаимодействие есть, аномальную метку снять.
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
