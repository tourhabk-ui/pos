// @vitest-environment node
/**
 * Партия 2 разбора периметра (07.09): партнёрская ссылка и оценка Кузьмича.
 *
 * Оба случая — не «открытая дверь»: Edge требует сессию, адресов нет в
 * PUBLIC_API_ROUTES. Беды другие, и у каждой своя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAllowedAffiliateHost } from '@/app/api/affiliate/link/route';

const ROOT = process.cwd();
const FEEDBACK = readFileSync(join(ROOT, 'app/api/tourist/feedback/agent/route.ts'), 'utf-8');

describe('партнёрскую ссылку нельзя выписать куда угодно', () => {
  /**
   * Адрес принимал ЛЮБОЙ url и возвращал ссылку с НАШИМ маркером: всякий
   * вошедший мог одолжить партнёрский идентификатор платформы под
   * произвольное назначение. Это не утечка данных, а заём учётной записи.
   */
  it('свои витрины проходят, включая поддомены', () => {
    for (const u of [
      'https://aviasales.ru/search',
      'https://www.aviasales.ru/search',
      'https://search.hotellook.com/hotels',
      'https://ostrovok.ru/hotel/x',
      'https://tp.media/click?x=1',
    ]) {
      expect(isAllowedAffiliateHost(u), `отклонён свой хост: ${u}`).toBe(true);
    }
  });

  it('чужой хост не проходит, и подделка под свой — тоже', () => {
    for (const u of [
      'https://evil.com/aviasales.ru',        // свой хост в пути, а не в хосте
      'https://aviasales.ru.evil.com/x',      // свой хост как приставка чужого
      'https://notaviasales.ru/x',            // хвост совпал, граница метки нет
      'https://example.com',
    ]) {
      expect(isAllowedAffiliateHost(u), `пропущен чужой хост: ${u}`).toBe(false);
    }
  });

  it('мусор вместо адреса — отказ, а не исключение', () => {
    for (const u of ['не адрес', '', 'javascript:alert(1)']) {
      expect(isAllowedAffiliateHost(u)).toBe(false);
    }
  });
});

describe('оценка Кузьмича: не ничья, не немая, не со своим счётчиком', () => {
  it('автор берётся из сессии, а не из тела запроса', () => {
    expect(FEEDBACK).toContain('getUserFromRequest');
    expect(FEEDBACK).toContain('author_user_id');
    // Клиент, называющий себя сам, подписью не является.
    expect(FEEDBACK).not.toMatch(/author_user_id:\s*parsed\.data/);
  });

  it('отказ ЗАПИСИ попадает в лог вместе с SQLSTATE (§4.0)', () => {
    // Судится catch вокруг записи, а не всякий пустой catch в файле: разбор
    // тела ловит негодный JSON, и там ошибка САМА является ответом — она
    // уходит клиенту строкой «Некорректный JSON». А отказ базы без строки в
    // логе неотличим от «таблицы нет», «прав нет» и «поле не влезло».
    const write = FEEDBACK.slice(FEEDBACK.indexOf('pool.query'));
    expect(write, 'пустой catch превращает поломку записи в «данных нет»')
      .not.toMatch(/catch\s*\{\s*\n\s*return/);
    expect(write).toContain('console.error');
    expect(write).toMatch(/SQLSTATE/);
  });

  it('счётчик частоты общий, а не своя копия', () => {
    expect(FEEDBACK).toContain('createRateLimiter');
    expect(FEEDBACK, 'рукописная Map — вторая реализация того же, расходятся молча')
      .not.toMatch(/new Map<string,\s*\{\s*count/);
  });

  it('граница счётчика названа вслух, а не выдана за надёжную', () => {
    // Он в памяти процесса и рестарта не переживает. Для оценки ответа это
    // принятая цена; в публичном MCP та же беда стоила переезда в базу.
    expect(FEEDBACK).toMatch(/в памяти процесса/);
  });
});
