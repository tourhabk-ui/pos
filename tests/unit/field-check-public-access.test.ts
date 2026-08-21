/**
 * Форма полевой проверки должна пускать анонима — сторож реестра.
 *
 * 21.08 форма выехала на прод и молча не работала: страница открывалась,
 * а всякий её запрос Edge-гвард отдавал как `401 Не авторизован` — путь
 * `/api/field-check` забыли внести в реестр публичных. Тесты этого не
 * поймали, потому что все они читали ИСХОДНИКИ, а не спрашивали гварда.
 *
 * Форма анонимна по устройству: человек в поле стоит в перчатке, на одной
 * палке связи и без аккаунта — регистрация отняла бы саму возможность
 * сверки. Значит «пускает ли Edge» — это часть её работоспособности,
 * такая же, как SQL внутри.
 *
 * Сторож читает КАТАЛОГ роутов, а не список в тексте: новый эндпоинт
 * формы попадёт под проверку сам, без правки теста. Роут без внятного
 * экспорта метода — не «нечего проверять», а красный: третий исход
 * («не смог») не равен первому (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

const ROOT = join(process.cwd(), 'app/api/field-check');

interface Endpoint { name: string; methods: string[] }

function endpoints(): Endpoint[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const file = join(ROOT, e.name, 'route.ts');
      const src = existsSync(file) ? readFileSync(file, 'utf-8') : '';
      const methods = [...src.matchAll(/export\s+async\s+function\s+([A-Z]+)\s*\(/g)]
        .map(m => m[1])
        .filter(m => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m));
      return { name: e.name, methods };
    });
}

describe('поле: Edge пускает анонима в форму проверки', () => {
  const list = endpoints();

  it('роуты формы вообще найдены — пустой список это отказ, а не успех', () => {
    expect(list.length).toBeGreaterThan(0);
  });

  it.each(list)('$name объявляет хотя бы один метод', ({ name, methods }) => {
    expect(methods, `${name}/route.ts: не нашёл экспорта метода — проверить нечем`)
      .not.toHaveLength(0);
  });

  it.each(list.flatMap(e => e.methods.map(m => ({ name: e.name, method: m }))))(
    'аноним доходит до $method /api/field-check/$name',
    ({ name, method }) => {
      expect(isPublicApiPath(`/api/field-check/${name}`, method)).toBe(true);
    },
  );

  it('чужой метод в реестр не проваливается', () => {
    expect(isPublicApiPath('/api/field-check/report', 'DELETE')).toBe(false);
  });
});
