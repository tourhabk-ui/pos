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
 *      Пункты 3 и 4 сперва чинились в модуле, а 16.11 (#1428, слово владельца
 *      «карт-бланш») модуль `lib/notifications/sms.ts` удалён: его не
 *      импортировал никто, а судья продолжал находить в нём ключ в адресе
 *      GET-запроса и запросы без срока. Долг снят так же, как у 1-2.
 * 5.   `SMTP_USER/SMTP_PASS || ''` — транспорт создавался с пустыми
 *      учётными данными, и «не настроено» приходило как «не смогли отправить».
 * 6.   `%` и `_` из аргумента инструмента Кузьмича расширяли шаблон ILIKE.
 *
 * Проверки ниже держат ИСХОД каждой правки, а не факт её совершения: текст,
 * который можно случайно вернуть, и поведение, которое можно проверить.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

describe('3-4. Сирота SMS удалена, а не «починена»', () => {
  it('lib/notifications/sms.ts не существует', () => {
    expect(
      existsSync(join(ROOT, 'lib/notifications/sms.ts')),
      'модуль SMS вернулся: ключ в адресе запроса и запросы без срока вместе с ним',
    ).toBe(false);
  });

  it('его никто не импортирует', () => {
    // Импорт удалённого модуля не собрался бы, поэтому здесь ищется именно
    // путь: строка в коде, указывающая на модуль, которого нет.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
        if (!/\.(ts|tsx|js|mjs)$/.test(name)) continue;
        if (read(rel).includes('notifications/sms')) hits.push(rel);
      }
    };
    for (const d of ['app', 'lib', 'components', 'hooks', 'scripts']) {
      if (existsSync(join(ROOT, d))) walk(d);
    }
    expect(hits, 'код ссылается на удалённый модуль SMS').toEqual([]);
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

describe('6а. ILIKE во всех инструментах агента (аудит MCP 29.09)', () => {
  // Кузьмич и MCP получают эти аргументы от человека или модели: `%` в
  // названии места превращал поиск «Ксудач» в «что угодно». Каждый файл —
  // проверенное решение, а не замена вслепую (шапка lib/db/like.ts).
  const TOOLS = [
    'lib/kuzmich/guardian-context.ts',
    'lib/kuzmich/place-info-tool.ts',
    'lib/kuzmich/weather-tool.ts',
    'lib/kuzmich/tour-availability-tool.ts',
    'lib/kuzmich/accommodation-search.ts',
    'lib/kuzmich/core.ts',
    'lib/agents/sdk/tourist-tools.ts',
  ];
  it.each(TOOLS)('%s: шаблон «содержит» только через containsPattern', (f) => {
    const src = read(f);
    expect(src).toContain('containsPattern(');
    expect(src, 'шаблон снова склеен руками').not.toMatch(/`%\$\{[^`]*\}%`/);
  });
});
