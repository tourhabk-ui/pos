/**
 * Форма полевой проверки обязана открыться без сети — сторож.
 *
 * Владелец 22.08: «ну и как она работает, только по ссылке?». Разбор нашёл
 * две дыры, каждая из которых обнаруживается только в поле:
 *
 *  1. `/field-check` лежал среди ОПЦИОНАЛЬНЫХ адресов прекэша: одна попытка
 *     без повтора. Сеть моргнула при установке service worker — и на
 *     перевале человек получает «нет соединения» вместо формы.
 *
 *  2. Пути не было в списке офлайн-способных. Без сети он открывался лишь
 *     потому, что общая ветка тоже заглядывает в кэш, а свежую копию не
 *     получал никогда: в кэше оставалась версия с момента установки. Для
 *     экрана, который правят каждый день, это значит вчерашнюю форму в поле.
 *
 * Обе — про то, что «работает» и «работает там, где нужно» это разные вещи.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sw = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf-8');

function listOf(name: string): string[] {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(sw);
  if (m === null) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

describe('офлайн-оболочка полевой формы', () => {
  it('адрес формы кладётся в кэш С ПОВТОРАМИ, а не одной попыткой', () => {
    expect(listOf('FIELD_URLS')).toContain('/field-check');
    expect(sw).toMatch(/FIELD_URLS\.map\(\(u\) => cacheOne\(cache, u, [1-9]\)\)/);
  });

  it('форма не осталась среди best-effort адресов', () => {
    expect(listOf('OPTIONAL_URLS')).not.toContain('/field-check');
  });

  it('без сети отдаётся кэш формы, а не страница «нет соединения»', () => {
    expect(listOf('OFFLINE_CAPABLE_ROUTES')).toContain('/field-check');
  });

  it('удачный онлайн-заход обновляет кэш офлайн-способных путей', () => {
    // shouldCache=true идёт именно по белому списку — иначе в кэше навсегда
    // остаётся версия с момента установки.
    expect(sw).toMatch(/isOfflineCapable\(url\.pathname\)[\s\S]{0,120}navigateWithTimeout\(request, true\)/);
  });

  it('версия кэша поднята — иначе телефоны останутся на старом наборе', () => {
    const m = /const CACHE_NAME = 'kamchatour-v(\d+)'/.exec(sw);
    expect(m, 'не нашёл имя кэша').not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(28);
  });

  it('приём проверок не проходит через service worker (он пропускает не-GET)', () => {
    expect(sw).toMatch(/if \(request\.method !== 'GET'\) return;/);
  });
});
