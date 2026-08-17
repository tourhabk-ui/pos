/**
 * Сборку просим сами, а не ждём, что чужое приложение отреагирует.
 *
 * 17.08 выкладка встала дважды за день, и оба раза не по нашей вине.
 *
 * Утром вебхук молчал сутки: Timeweb собирал и поднимал контейнер, но брал
 * revision восемнадцатичасовой давности. Вечером — наоборот: GitHub доставил
 * пуш, вебхук показал «Last delivery was successful», Timeweb ответил 2xx и
 * сборку НЕ начал. Панель показывала последний коммит четырёхчасовой давности,
 * очередь стояла после четырёх подряд упавших сборок.
 *
 * Пока единственный запуск — реакция чужого приложения на событие, у нас нет
 * ни способа её вызвать, ни способа отличить «не дошло» от «дошло и
 * проигнорировано». Просьба напрямую снимает обе неизвестности.
 *
 * Два свойства этого шага важнее самого запроса.
 *
 * Первое: он НЕ судит. Если вебхук сработал, сборка уже идёт, и вторая просьба
 * вернёт ошибку — падать на ней значило бы красить прогон за то, что всё
 * хорошо. Судит по-прежнему сверка «что отдаёт САЙТ».
 *
 * Второе: он не печатает ответ целиком. В объекте приложения живут переменные
 * окружения прода — пароль базы, JWT-секрет, ключи провайдеров.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEPLOY = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf-8');

describe('просьба о сборке идёт до проверки', () => {
  it('шаг существует и стоит ПЕРЕД сверкой', () => {
    const ask = DEPLOY.indexOf('Ask Timeweb to build this commit');
    const verify = DEPLOY.indexOf('Verify deploy reached production');
    expect(ask).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(ask);
  });

  it('это POST, а не чтение', () => {
    expect(DEPLOY).toMatch(/-X POST -H "Authorization: Bearer \$TIMEWEB_TOKEN"/);
  });
});

describe('просьба не судит о результате', () => {
  const step = DEPLOY.slice(
    DEPLOY.indexOf('Ask Timeweb to build this commit'),
    DEPLOY.indexOf('Verify deploy reached production'),
  );

  it('отказ Timeweb не роняет прогон', () => {
    // Вебхук мог сработать первым: тогда сборка уже идёт, и вторая просьба
    // законно вернёт ошибку.
    expect(step).toMatch(/::warning::/);
    expect(step).not.toMatch(/exit 1/);
  });

  it('отсутствие токена тоже не роняет — ждём вебхук', () => {
    // Здесь exit 0 уместен, в отличие от самой сверки: пропущенная просьба
    // оставляет прежний порядок вещей, а пропущенная сверка выдала бы
    // непроверенное за проверенное.
    expect(step).toMatch(/exit 0/);
  });

  it('судит по-прежнему сверка сайта', () => {
    expect(DEPLOY).toMatch(/Контейнер не переключился/);
  });
});

describe('секреты прода не утекают в лог', () => {
  const step = DEPLOY.slice(
    DEPLOY.indexOf('Ask Timeweb to build this commit'),
    DEPLOY.indexOf('Verify deploy reached production'),
  );

  it('токен уходит только заголовком', () => {
    expect(step).not.toMatch(/echo .*\$TIMEWEB_TOKEN/);
  });

  it('ответ печатается урезанным', () => {
    // В объекте приложения лежат переменные окружения прода.
    expect(step).toMatch(/head -c \d+ \/tmp\/deploy-ask\.json/);
    expect(step).not.toMatch(/cat \/tmp\/deploy-ask\.json/);
  });
});
