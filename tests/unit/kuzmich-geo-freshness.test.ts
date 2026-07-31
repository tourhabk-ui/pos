/**
 * Кузьмич не должен отвечать по координатам из прошлого рендера.
 *
 * Найдено при разборе #885. `send` в KuzmichWidget — это `useCallback`, а
 * `location`, `mode` и `permissionState` приходят из `useGeo()` и в списке
 * зависимостей отсутствовали. Замыкание держало их значения с того рендера,
 * где колбэк создался.
 *
 * Геолокация приходит асинхронно: разрешение, потом фикс GPS. Пока она едет,
 * человек уже может задать первый вопрос — а первый вопрос в поле как раз чаще
 * всего «где я» и «что рядом». Такой вопрос уходил на сервер БЕЗ координат, и
 * молча: интерфейс отвечает как обычно, просто Кузьмич не знает, где человек.
 *
 * Дальше баг сам себя маскировал: `messages` меняется с каждым сообщением,
 * колбэк пересоздаётся, и со второго вопроса координаты уже свежие. Ломался
 * ровно первый контакт — то есть тот случай, ради которого геолокация и нужна.
 *
 * Сторож не хранит список имён у себя: он берёт то, что реально
 * деструктурируется из `useGeo()`, и требует этого же в зависимостях. Добавят
 * из контекста четвёртое поле — оно попадёт под проверку само.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'components/kuzmich/KuzmichWidget.tsx'), 'utf-8');
/** Комментарии называют те же поля — сверять надо код. */
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Что виджет берёт из гео-контекста. */
function geoFields(): string[] {
  const m = /const\s*\{([^}]+)\}\s*=\s*useGeo\(\)/.exec(CODE);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean);
}

/** Массив зависимостей у колбэка `send`. */
function sendDeps(): string[] {
  const start = CODE.indexOf('const send = useCallback(');
  if (start < 0) return [];
  const m = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(CODE.slice(start));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

describe('гео-контекст Кузьмича', () => {
  it('разбор состоялся — иначе сторож молчал бы впустую', () => {
    expect(geoFields().length).toBeGreaterThan(0);
    expect(sendDeps().length).toBeGreaterThan(0);
  });

  it('каждое поле из useGeo() есть в зависимостях send', () => {
    const deps = sendDeps();
    for (const f of geoFields()) {
      expect(deps, `«${f}» читается в send, но его нет в зависимостях — координаты застынут на первом рендере`).toContain(f);
    }
  });

  it('координаты уходят только при разрешении и режиме «на месте»', () => {
    // Отдельно от свежести: даже свежую позицию нельзя слать, когда человек
    // не на Камчатке или не давал разрешения. Это про ПД, не про UX.
    expect(CODE).toMatch(/permissionState === 'granted'[\s\S]{0,60}mode === 'on-site'/);
  });
});
