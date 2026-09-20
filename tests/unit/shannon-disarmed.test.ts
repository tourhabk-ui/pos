/**
 * Сторож: Shannon остаётся разряженным.
 *
 * Решение владельца 19.09 («Разрядить Shannon») после разбора вопроса
 * «кладу деньги на Claude, и они за минуты исчезают».
 *
 * Shannon — ЧУЖОЙ агентный фреймворк (KeygraphHQ/shannon): мы его клонируем
 * и отдаём ему ключ. Сколько он потратит, наш код не решает — это не наш
 * водопад и не наши потолки токенов. Было: общий ключ платформы, цель
 * зашита в команду, два часа таймаута, запуск одним нажатием. Прогонов за
 * всю историю ноль, то есть баланс уцелел по везению, а не по устройству.
 *
 * Сторож держит ровно то, что разряжает ружьё, и НЕ держит того, чего у нас
 * нет. Потолка расхода здесь не существует — Shannon ходит к Anthropic сам;
 * проверять «ограничение трат» значило бы сторожить обещание вместо
 * механизма (§10.09).
 *
 * Разряжено тремя вещами:
 *   — ключ отдельный, а не общий: сгоревший не уносит платформу;
 *   — цель называется при запуске, а хост подтверждается руками;
 *   — оба отказа случаются ДО клонирования и до первого обращения к модели.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WF = readFileSync(
  join(process.cwd(), '.github/workflows/shannon-pentest.yml'), 'utf8',
);

describe('ключ у Shannon отдельный', () => {
  it('общий ключ платформы сюда не подставляется', () => {
    // Главная правка. Общий ключ означал бы, что чужой цикл без сметы
    // способен остановить судью эволюции, Editor и Кузьмича.
    expect(WF).not.toMatch(/secrets\.ANTHROPIC_API_KEY/);
  });

  it('используется SHANNON_ANTHROPIC_API_KEY', () => {
    expect(WF).toMatch(/ANTHROPIC_API_KEY:\s*\$\{\{\s*secrets\.SHANNON_ANTHROPIC_API_KEY\s*\}\}/);
  });

  it('нет ключа — отказ с причиной, а не тихий прогон вхолостую', () => {
    // Пустой ключ не «пропускает шаг»: Shannon упал бы уже после клона, и
    // причина утонула бы в чужом выводе.
    expect(WF).toContain('SHANNON_ANTHROPIC_API_KEY не задан');
    expect(WF).toMatch(/if \[ -z "\$\{SHANNON_KEY:-\}" \]/);
  });
});

describe('цель называется руками', () => {
  it('адрес не зашит в команду', () => {
    // Прежде в команде стоял `URL=https://vedarai.ru` при имени «(Staging)»:
    // имя обещало полигон, код целился в боевую площадку. Проверяется САМА
    // КОМАНДА — в шапке прежняя форма процитирована намеренно, как описание
    // починенного.
    expect(WF).not.toMatch(/\.\/shannon start URL=https:/);
    expect(WF).toMatch(/\.\/shannon start URL="\$TARGET_URL"/);
  });

  it('оба поля запуска обязательны', () => {
    for (const field of ['target_url', 'confirm_host']) {
      const at = WF.indexOf(`${field}:`);
      expect(at, `нет поля ${field}`).toBeGreaterThan(0);
      expect(WF.slice(at, at + 400), field).toMatch(/required: true/);
    }
  });

  it('хост сверяется с повторённым, и несовпадение останавливает прогон', () => {
    expect(WF).toMatch(/if \[ "\$HOST" != "\$CONFIRM_HOST" \]/);
    const at = WF.indexOf('"$HOST" != "$CONFIRM_HOST"');
    expect(WF.slice(at, at + 400)).toContain('exit 1');
  });

  it('прод не молчит о том, что он прод', () => {
    // Запускать по проду можно — площадка своя. Нельзя сделать это, не зная.
    expect(WF).toContain('vedarai.ru');
    const at = WF.indexOf('"$HOST" = "vedarai.ru"');
    expect(at).toBeGreaterThan(0);
    expect(WF.slice(at, at + 400)).toContain('SOS');
  });
});

describe('отказ не стоит денег', () => {
  it('проверка идёт ДО клонирования Shannon', () => {
    // Иначе неверно заполненный запуск оплачивался бы работой чужого агента.
    const check = WF.indexOf('Проверить прицел и ключ');
    const clone = WF.indexOf('Clone Shannon');
    const run = WF.indexOf('Run Shannon Pentest');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(clone);
    expect(clone).toBeLessThan(run);
  });

  it('запуск только по явному запросу — ни расписания, ни пуша', () => {
    const on = WF.slice(WF.indexOf('\non:'), WF.indexOf('permissions:'));
    expect(on).toContain('workflow_dispatch');
    expect(on).not.toMatch(/\bschedule:/);
    expect(on).not.toMatch(/\bpush:/);
  });
});
