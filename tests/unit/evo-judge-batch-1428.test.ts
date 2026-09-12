/**
 * Шесть находок Evo Judge из окна 12.09 (#1428) — и то, чем каждая закрыта.
 *
 * Судья вынес «по делу» шести находкам; сверка с `main` подтвердила все шесть.
 * Но серьёзность у двух из них оказалась не та, что читается из формулировки,
 * и это записано здесь, а не только в issue: тело выпуска судьи
 * перезаписывается каждым прогоном, а тест живёт вместе с кодом.
 *
 * 1-2. «Статус платежа всегда success» и «Заглушка возвращает успех без
 *      вызова» — `lib/payments/transfer-payments.ts`. Обе верны про код и
 *      недостижимы в работе: файл на 515 строк не импортировал НИКТО. Долг
 *      снят удалением. Реализовывать там CloudPayments значило бы завести
 *      второй приёмник денег рядом с настоящим (§7), а живой путь трансферов
 *      другой — `/api/hub/carrier/*` и СБП Точка.
 * 3.   Пустой `if (!this.apiKey) {}` в конструкторе SMS — §4.0 в чистом виде:
 *      состояние «ключа нет» распознано и не названо.
 * 4.   Ключ SMS-провайдера в строке запроса без кодирования.
 * 5.   `SMTP_USER/SMTP_PASS || ''` — транспорт создавался с пустыми
 *      учётными данными, и «не настроено» приходило как «не смогли отправить».
 * 6.   `%` и `_` из аргумента инструмента Кузьмича расширяли шаблон ILIKE.
 *
 * Проверки ниже держат ИСХОД каждой правки, а не факт её совершения: текст,
 * который можно случайно вернуть, и поведение, которое можно проверить.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeLike, containsPattern } from '@/lib/db/like';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('1-2. Сирота денежного пути удалена, а не «починена»', () => {
  it('lib/payments/transfer-payments.ts не существует', () => {
    expect(
      existsSync(join(ROOT, 'lib/payments/transfer-payments.ts')),
      'файл вернулся: заглушки «статус всегда success» и «возврат без вызова» вместе с ним',
    ).toBe(false);
  });

  it('его никто не импортирует — ни код, ни реестры сторожей', () => {
    // Записи в замороженных реестрах — тоже ссылки. Реестр, помнящий
    // удалённый файл, описывает несуществующий долг (правило 10.09).
    const guard = read('tests/unit/silent-catch-guard.test.ts');
    const referenced = guard
      .split('\n')
      .filter((l) => l.includes("'lib/payments/transfer-payments.ts'") && !l.trimStart().startsWith('//'));
    expect(referenced, 'путь к удалённому файлу остался живой записью реестра').toEqual([]);
  });
});

describe('3. SMS: «ключа нет» произносится вслух', () => {
  const src = read('lib/notifications/sms.ts');

  it('в конструкторе нет ветки с пустым телом', () => {
    // Именно `if (!this.apiKey) {\n}` стоял здесь и не делал ничего.
    expect(src, 'пустая ветка вернулась — отказ снова молчит').not.toMatch(
      /if\s*\(!this\.apiKey\)\s*\{\s*\}/,
    );
  });

  it('отказ уходит в лог с именем переменной', () => {
    expect(src).toContain('logSwallowedFailure');
    expect(src).toContain('SMS_RU_API_KEY');
  });

  it('в лог идёт ИМЯ переменной, а не её значение', () => {
    // `${this.apiKey}` в тексте сообщения — это ключ в логе.
    expect(src).not.toMatch(/logSwallowedFailure\([\s\S]{0,300}\$\{this\.apiKey\}/);
  });
});

describe('4. SMS: ключ и id не склеиваются в URL руками', () => {
  const src = read('lib/notifications/sms.ts');

  it('нет интерполяции ключа прямо в адрес', () => {
    expect(src, 'ключ снова подставляется в строку запроса без кодирования').not.toMatch(
      /https:\/\/sms\.ru\/[^\n`]*\$\{this\.apiKey\}/,
    );
  });

  it('адрес собирается через URL/searchParams — кодирование делает платформа', () => {
    expect(src).toContain("new URL('https://sms.ru/sms/status')");
    expect(src).toContain("new URL('https://sms.ru/my/balance')");
    expect(src).toContain('searchParams.set');
  });
});

describe('5. Почта: «не настроено» отличимо от «не смогли отправить»', () => {
  const src = read('lib/notifications/email.ts');

  it('незаданные переменные собираются по именам', () => {
    expect(src).toContain('SMTP_USER');
    expect(src).toContain('SMTP_PASS');
    expect(src).toContain('missingEnv');
  });

  it('при незаданных настройках до SMTP не идём вовсе', () => {
    // Проверка обязана стоять ДО try/sendMail, иначе ответ придёт от
    // почтового сервера и будет выглядеть как проблема доступа.
    const check = src.indexOf('this.missingEnv.length > 0');
    const send = src.indexOf('this.transporter.sendMail');
    expect(check, 'проверка настроек пропала').toBeGreaterThan(-1);
    expect(send, 'отправка пропала').toBeGreaterThan(-1);
    expect(check, 'отправка идёт раньше проверки настроек').toBeLessThan(send);
  });

  it('в текст ошибки не попадает значение пароля', () => {
    expect(src).not.toMatch(/process\.env\.SMTP_PASS[^\n]*error/);
  });
});

describe('6. ILIKE: шаблон ищет текст, а не всё подряд', () => {
  // Детектор обязан уметь и находить, и не находить — иначе он зеленеет
  // сломанным. Здесь это проверяется на значениях, а не на тексте файла.
  it('спецсимволы шаблона экранируются', () => {
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('_')).toBe('\\_');
    expect(escapeLike('a%b_c')).toBe('a\\%b\\_c');
  });

  it('обратная косая экранируется ПЕРВОЙ', () => {
    // Иначе `\` съел бы экранирование следующего символа и `%` снова стал бы
    // подстановочным: `\%` → `\\%` (косая как текст) + `%` как маска.
    expect(escapeLike('\\')).toBe('\\\\');
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('обычный текст не меняется', () => {
    expect(escapeLike('палатка Tramp')).toBe('палатка Tramp');
    expect(containsPattern('кошки')).toBe('%кошки%');
  });

  it('инструмент Кузьмича собирает шаблон через общую функцию', () => {
    const src = read('lib/kuzmich/gear-search.ts');
    expect(src).toContain('containsPattern');
    expect(src, 'шаблон снова склеивается руками — `%` из переписки расширит поиск').not.toMatch(
      /`%\$\{args\.(query|category)\}%`/,
    );
  });
});
