/**
 * Деплой подтверждается фактом, а не словом.
 *
 * 04.08. Пять смерженных PR подряд, зелёные галочки везде — и прод сутки
 * отдавал старый контейнер: владелец третий день видел на телефоне баги,
 * исправленные в main. Причина не в коде карточки, а в проверке деплоя: шаг
 * спрашивал статус приложения ЧЕРЕЗ СЕКУНДУ после старта сборки, печатал
 * «Status: deploy» (это «идёт сборка», а не «готово») и завершался зелёным.
 * Чем кончилась сборка, не проверял никто и никогда.
 *
 * Это ровно тот класс, против которого заведены остальные сторожа: зелёное,
 * потому что никто не спросил. Здесь — чтобы шаг не вернулся к одному curl.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEPLOY = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf-8');

/** Строки без комментариев: пояснения не должны считаться кодом шага. */
const code = DEPLOY.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('деплой проверяется до конца', () => {
  it('статус опрашивается в цикле, а не один раз', () => {
    expect(code).toMatch(/for i in \$\(seq 1 \$ATTEMPTS\)/);
    expect(code).toMatch(/ATTEMPTS=\d+/);
  });

  it('промежуточные статусы сборки не считаются успехом', () => {
    // «deploy» — это «идёт сборка». Раньше именно оно печаталось как результат.
    expect(code).toMatch(/deploy\|build\|building\|deploying\|pending\|created/);
  });

  it('несобравшийся деплой красит workflow', () => {
    expect(code).toMatch(/::error::/);
    expect(code).toMatch(/exit 1/);
  });

  it('сверяется коммит: прод должен работать именно на голове main', () => {
    expect(code).toMatch(/EXPECTED_SHA/);
    expect(code).toMatch(/COMMIT:0:7.*!=.*EXPECTED_SHA:0:7|EXPECTED_SHA:0:7.*!=.*COMMIT:0:7/);
  });

  it('последнее слово — за сайтом, а не за панелью', () => {
    // Панель отвечает на вопрос «что со сборкой», сайт — «какой контейнер
    // сейчас отдаёт страницы». Три дня разошлись именно между этими вопросами.
    expect(code).toMatch(/vedarai\.ru\/version\.json/);
    expect(code).toMatch(/Контейнер не переключился/);
  });

  it('отсутствие токена — не зелёный прогон', () => {
    // Раньше без токена шаг выходил с 0: «проверить нечем» выглядело как
    // «проверено». Это и есть подтверждение словом.
    const noToken = code.slice(code.indexOf('TIMEWEB_TOKEN" ]'), code.indexOf('Приложение $APP_ID'));
    expect(noToken).toMatch(/exit 1/);
    expect(noToken).not.toMatch(/exit 0/);
  });
});
