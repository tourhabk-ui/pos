/**
 * Находка ревью обязана указывать на файл, тело которого модель видела.
 *
 * Инцидент 25.07.2026: issue-reporter вынес в GitHub десять critical-issues
 * (#767-776) — SQL-инъекции с четырьмя РАЗНЫМИ выдуманными «кодами» на одной
 * и той же строке и «инъекция» в корректном параметризованном запросе
 * (`WHERE telegram_chat_id = $1` объявлен уязвимостью). Все закрыты вручную
 * после сверки с реальным кодом.
 *
 * Механика провала: тело файла не прочиталось → файла нет в fileContents →
 * verifyAgainstSource получал undefined и ПРОПУСКАЛ находку
 * (`if (!source) return null`). Страж отключался ровно тогда, когда модель
 * галлюцинирует сильнее всего — по одному имени файла. Пятый случай за
 * 25.07.2026, когда защита существовала, но не в точке действия.
 *
 * Сам `if (!source) return null` в verifyAgainstSource оставлен: это его
 * честный контракт («не могу проверить — не сужу»). Требование «тело должно
 * быть прочитано» — отдельное условие фильтра, и этот тест держит его на месте.
 */
import { describe, it, expect } from 'vitest';
import { verifyAgainstSource } from '@/lib/agents/evo/finding-guard';
import { readFileSync } from 'fs';
import { join } from 'path';

const GROWTH = readFileSync(join(process.cwd(), 'lib/agents/evo/growth-agent.ts'), 'utf-8');

describe('находки по непрочитанным файлам не проходят', () => {
  it('фильтр требует fileContents.has(p.file) ДО всех остальных проверок', () => {
    const filterBlock = GROWTH.match(/const filtered = parsed\.filter\([\s\S]*?\);/)?.[0] ?? '';
    expect(filterBlock).not.toBe('');
    expect(filterBlock).toMatch(/fileContents\.has\(p\.file\)/);

    // Требование стоит раньше ВЫЗОВА verifyAgainstSource( — иначе дыра
    // вернётся: верификация с undefined-источником пропускает всё. Ищем именно
    // вызов со скобкой: имя функции упоминается и в комментарии над условием.
    const hasAt = filterBlock.indexOf('fileContents.has(');
    const verifyAt = filterBlock.indexOf('verifyAgainstSource(');
    expect(hasAt).toBeGreaterThanOrEqual(0);
    expect(hasAt).toBeLessThan(verifyAt);
  });

  it('контракт verifyAgainstSource без источника — «не сужу», и это документировано здесь', () => {
    // Пропуск при отсутствии источника — осознанное поведение ФУНКЦИИ
    // (она не может судить о том, чего не видела). Опасным его делает только
    // вызов без гарантии, что источник был, — что и закрывает фильтр выше.
    const f = { title: 'Отсутствует requireAuth', description: 'route без auth', suggestion: 'добавить requireAuth' };
    expect(verifyAgainstSource(f, null)).toBeNull();
    expect(verifyAgainstSource(f, undefined)).toBeNull();
    // А с источником, где auth ЕСТЬ, — ловит ложь.
    expect(verifyAgainstSource(f, 'const u = await verifyToken(token); // auth')).toBe('source_has_auth');
  });
});
