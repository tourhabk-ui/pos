/**
 * Письма: значения экранируются, тема не принимает чужих заголовков.
 *
 * Находка судьи эволюции 08.09 (issue #1428): в `lib/notifications/email.ts`
 * маршрут, имя водителя, телефон и суммы подставлялись в HTML и в
 * `href="tel:"` БЕЗ экранирования. Значения приходят из брони, то есть в
 * конечном счёте от человека, а письмо читает другой человек.
 *
 * Экранирование заведено ОДНО на платформу (`lib/text/escape-html.ts`): в
 * репозитории уже семнадцать своих `esc`/`escapeHtml`, и они не одинаковы —
 * часть закрывает только `& < >`. Правило, написанное семнадцать раз, это
 * семнадцать правил (§12).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml, telHref, safeSubject } from '@/lib/text/escape-html';

describe('общее экранирование', () => {
  it('закрывает угловые скобки и кавычки', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a"b\'c&d')).toBe('a&quot;b&#39;c&amp;d');
  });

  it('амперсанд обрабатывается первым — иначе двойное экранирование', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('null и undefined — пустая строка, а не «null»', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('телефон в href оставляет только цифры и разделители', () => {
    expect(telHref('+7 (999) 123-45-67')).toBe('+7 (999) 123-45-67');
    // «javascript:alert(1)» после чистки букв даёт «(1)» — на телефон не
    // похоже, значит ссылки не будет вовсе.
    expect(telHref('javascript:alert(1)')).toBe('');
    // Остаток «+7999» — четыре цифры, на телефон тоже не похоже.
    expect(telHref('+7999"onmouseover="x')).toBe('');
    expect(telHref('84152123456')).toBe('84152123456');
  });

  it('тема письма теряет переводы строки — ими дописывают свои заголовки', () => {
    expect(safeSubject('Бронь\r\nBcc: chuzhoy@example.com')).toBe('Бронь Bcc: chuzhoy@example.com');
    // Но не превращается в HTML-мусор: тема — заголовок, а не разметка.
    expect(safeSubject('Маршрут <Авача>')).toBe('Маршрут <Авача>');
  });
});

describe('шаблоны писем', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/notifications/email.ts'), 'utf8');
  const htmlBlocks = SRC.match(/const html = `[\s\S]*?`;/g) ?? [];

  it('шаблоны вообще есть — иначе тест сторожит пустоту', () => {
    expect(htmlBlocks.length).toBeGreaterThanOrEqual(5);
  });

  it('в HTML не осталось ни одной неэкранированной подстановки', () => {
    const raw: string[] = [];
    for (const block of htmlBlocks) {
      for (const m of block.matchAll(/\$\{([^{}]*)\}/g)) {
        const inner = m[1].trim();
        // Вызовы map/тернарники, собирающие разметку, — это код, а не значение.
        if (/^(e|telHref)\(/.test(inner)) continue;
        if (/\.map\(|\?\s*`/.test(inner)) continue;
        raw.push(inner.slice(0, 60));
      }
    }
    expect(raw, `не экранировано: ${raw.join(' | ')}`).toEqual([]);
  });

  it('телефон в href идёт через telHref, а не через экранирование', () => {
    expect(SRC).toMatch(/href="tel:\$\{telHref\(/);
    expect(SRC).not.toMatch(/href="tel:\$\{e\(/);
  });

  /**
   * Выдуманный контакт в письме хуже отсутствующего.
   *
   * До 09.09 в футере подтверждения трансфера стояло «+7 (XXX) XXX-XX-XX» —
   * плейсхолдер из первой версии шаблона, уезжавший в настоящее письмо
   * настоящему туристу. Человек, которому понадобилось позвонить по броне,
   * получал номер, по которому нельзя дозвониться, и узнавал об этом в тот
   * момент, когда звонил. Отсутствие телефона он бы увидел сразу и пошёл
   * другим путём.
   *
   * Тот же механизм, что в §4.0: место, где нельзя сказать «не знаю»,
   * заполняется выдумкой. Появится настоящий номер — придёт из переменной
   * окружения, а не из шаблона.
   */
  it('в письмах нет плейсхолдеров вместо контактов', () => {
    // Комментарии выброшены: объяснение, ПОЧЕМУ плейсхолдер убран, само
    // плейсхолдером не является. Первая версия этой проверки покраснела на
    // собственном пояснении в коде — а сторож, красный на объяснении, учит
    // объяснения не писать.
    const code = SRC
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
    const placeholders = [/\+7\s*\(X{3}\)/i, /X{3}-X{2}-X{2}/i, /\bTODO\b/, /\bпример@/i];
    for (const re of placeholders) {
      expect(code, `плейсхолдер ${re} в шаблоне письма`).not.toMatch(re);
    }
  });

  it('все темы писем проходят через safeSubject', () => {
    const subjects = SRC.match(/const subject = [^;]+;/g) ?? [];
    expect(subjects.length).toBeGreaterThanOrEqual(5);
    for (const s of subjects) expect(s, s).toMatch(/safeSubject\(/);
  });
});

describe('прочие находки судьи', () => {
  it('отладочный вывод лидов не идёт в проде', () => {
    const SRC = readFileSync(join(process.cwd(), 'lib/analytics/lead-tracking.ts'), 'utf8');
    expect(SRC).toMatch(/NODE_ENV !== 'production'/);
  });

  it('разбор ленты операторов идёт водопадом, а не единственной моделью', () => {
    // Прямой вызов без фолбэка ронял разбор источника целиком.
    const SRC = readFileSync(join(process.cwd(), 'lib/agents/execution/handlers/operator-outreach-executor.ts'), 'utf8');
    expect(SRC).not.toMatch(/callAIWithModelDirect/);
    expect(SRC).toMatch(/callAIFast\(messages\)/);
    expect(SRC).toMatch(/isWaterfallErrorResponse/);
  });
});
