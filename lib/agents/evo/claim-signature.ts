/**
 * Сигнатура претензии — ключ обратной связи эволюции.
 *
 * Проблема (инцидент 24.07): дедуп находок шёл по паре file_path+title, а
 * модель порождает ДЕСЯТЬ перефразировок одной претензии («Отсутствует
 * requireAuth», «Нет проверки авторизации», «Route не защищён middleware»…).
 * Титулы разные → дедуп бессилен → трекер завален, а человек, закрывший их
 * все, ничего системе не сообщил: завтра придут те же десять.
 *
 * Здесь мы сводим претензию к КЛАССУ (не к формулировке). Тогда:
 *   • один отвергнутый класс на файле глушит все его перефразировки;
 *   • вердикт человека («закрыл как not planned») превращается в правило,
 *     которое переживает переформулировку.
 *
 * Чистые функции — без БД и сети, под тестом.
 */

/** Классы претензий, которые модель формулирует особенно разнообразно. */
export type ClaimClass =
  | 'missing_auth'
  | 'missing_try_catch'
  | 'missing_lock'
  | 'sql_injection'
  | 'resource_leak'
  | 'convention'
  | 'other';

/**
 * Класс претензии по её тексту. Порядок проверок — от специфичного к общему:
 * «нет блокировки при бронировании» это missing_lock, а не convention.
 */
export function claimClass(text: string): ClaimClass {
  const t = text.toLowerCase();

  // ВАЖНО: русские окончания — через [а-яё]*, НЕ через \w*. В JS \w это
  // [A-Za-z0-9_], кириллицу он не матчит, поэтому «проверк\w*\s+прав» никогда
  // не срабатывало на «проверки прав» (тот же изъян найден в finding-guard).
  if (/\bsql[-\s]?инъекц|sql injection|конкатенац[а-яё]*\s+(?:строк|sql)/i.test(t)) return 'sql_injection';
  if (/race condition|гонк[а-яё]*|блокировк|for update|транзакц[а-яё]*\s+(?:нет|отсутств)|двойн[а-яё]*\s+бронир/i.test(t)) return 'missing_lock';
  if (/try\s*\/?\s*catch|необработанн[а-яё]*\s+(?:исключен|ошибк)|без обработки ошибок/i.test(t)) return 'missing_try_catch';
  if (/авториз|аутентифик|requireauth|requireadmin|requirerole|\bauth\b|проверк[а-яё]*\s+прав|jwt|неавторизованн/i.test(t)) return 'missing_auth';
  if (/pool\.connect|release\(\)|утечк[а-яё]*\s+(?:ресурс|соединен)|не освобожда/i.test(t)) return 'resource_leak';
  if (/конвенц|устаревш[а-яё]*\s+табл|console\.log|import pool|deprecated/i.test(t)) return 'convention';

  return 'other';
}

export interface SignatureInput {
  file_path?: string | null;
  title?: string | null;
  description?: string | null;
  suggestion?: string | null;
}

/**
 * Ключ «файл + класс претензии». Именно он попадает в стоп-лист: одна
 * отвергнутая претензия глушит все её будущие перефразировки по этому файлу.
 * Для 'other' добавляем нормализованный заголовок — иначе один отказ заглушил
 * бы все прочие (неклассифицированные) претензии по файлу.
 */
export function claimSignature(f: SignatureInput): string {
  const file = (f.file_path ?? '').trim() || '(no-file)';
  const text = `${f.title ?? ''} ${f.description ?? ''} ${f.suggestion ?? ''}`;
  const cls = claimClass(text);
  if (cls !== 'other') return `${file}::${cls}`;
  return `${file}::other:${normalizeTitle(f.title ?? '')}`;
}

/** Заголовок без пунктуации/регистра/лишних пробелов — стабильный хвост ключа. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Отфильтровывает находки, чья сигнатура уже отвергнута человеком.
 * Чистая — стоп-лист приходит снаружи (из БД).
 */
export function dropRejected<T extends SignatureInput>(findings: T[], rejected: Set<string>): T[] {
  return findings.filter((f) => !rejected.has(claimSignature(f)));
}
