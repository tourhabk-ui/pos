/**
 * Обход недоступного Alpine CDN стоит во ВСЕХ стадиях, где ставится пакет.
 *
 * `dl-cdn.alpinelinux.org` — это Fastly, и с билд-серверов Timeweb он
 * периодически рвёт TLS. 19.07 деплой падал на `apk add libc6-compat`; тогда
 * завели фолбэк на зеркало Яндекса — но ТОЛЬКО в стадии `deps`. Стадия
 * `runner` осталась с голым `apk add`.
 *
 * Пока CDN отвечал, разницы не было. 17.08 он снова отдал TLS-ошибку, и сборка
 * легла ровно на той строке, где страховки нет:
 *
 *     ERROR: unable to select packages: libc6-compat (no such package)
 *     error: failed to solve: process "/bin/sh -c apk add --no-cache libc6-compat"
 *
 * При этом панель Timeweb показала приложение как `active`: старый контейнер
 * продолжал работать, и без сверки «что отдаёт САЙТ» это выглядело бы удачным
 * деплоем. Поймала расхождение проверка выкладки — сайт двадцать раз подряд
 * отдавал предыдущий коммит.
 *
 * Страховка, поставленная в одном из двух мест, — это не страховка, а отсрочка.
 * Сторож требует её везде, где есть `apk add`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCKERFILE = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf-8');

/** Логические строки: продолжения через `\` склеиваются. */
const LOGICAL_LINES = DOCKERFILE.replace(/\\\r?\n\s*/g, ' ').split('\n');

const MIRROR = 'mirror.yandex.ru';

describe('apk add никогда не идёт без запасного зеркала', () => {
  const apkLines = LOGICAL_LINES.filter(l => /^\s*RUN\s.*\bapk add\b/.test(l));

  it('такие строки в Dockerfile есть — иначе сторож стерёг бы пустоту', () => {
    expect(apkLines.length).toBeGreaterThan(0);
  });

  it('каждая несёт фолбэк на зеркало', () => {
    for (const line of apkLines) {
      expect(line, `apk add без обхода: ${line.trim().slice(0, 80)}`).toContain(MIRROR);
      // Обход должен быть именно фолбэком (`||`), а не заменой: пока CDN жив,
      // тянуть через зеркало незачем.
      expect(line).toMatch(/\|\|/);
    }
  });

  it('обход есть и в стадии сборки, и в стадии рантайма', () => {
    // Ровно этого не хватило 17.08: в deps фолбэк был, в runner — нет.
    const deps = DOCKERFILE.indexOf('AS deps');
    const runner = DOCKERFILE.indexOf('AS runner');
    expect(deps).toBeGreaterThan(-1);
    expect(runner).toBeGreaterThan(deps);
    expect(DOCKERFILE.slice(deps, runner)).toContain(MIRROR);
    expect(DOCKERFILE.slice(runner)).toContain(MIRROR);
  });
});
