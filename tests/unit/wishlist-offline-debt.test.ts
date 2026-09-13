/**
 * Отметка избранного, поставленная без сети, доезжает до аккаунта.
 *
 * Находка Evo Judge 13.09: «сетевой сбой маскируется под успех» —
 * `lib/wishlist/client.ts` в `catch` возвращал `ok: true`. Разбор показал,
 * что вывод верный, а механизм глубже, чем в находке, и дефекта там было
 * ДВА:
 *
 *  1. **Досылки не существовало.** Шапка файла обещала «отметка живёт
 *     локально ДО ВОЗВРАЩЕНИЯ СВЯЗИ», но `readLocal` читался только внутри
 *     самого файла: ни одного вызова на событие `online` или при
 *     монтировании не было нигде в репозитории. Отметка не доезжала до
 *     аккаунта НИКОГДА — сердце закрашивалось, выглядело сохранённым, а на
 *     другом устройстве его не было. Докстрока, обещающая путь, которого
 *     нет, — дефект кода (§«объявленный исход без источника», 10.09).
 *
 *  2. **Третье состояние не доходило до человека.** `localOnly` возвращался
 *     клиентом и не читался НИКЕМ: единственным упоминанием в репозитории
 *     была строка теста, проверявшего производителя. `error` из хука тоже
 *     не рисовала ни одна из шести поверхностей. Исход «не смог» был
 *     неотличим от «получилось» — ровно §4.0.
 *
 * Поэтому сторож держит обе половины: и что долг записывается и досылается,
 * и что у обоих состояний есть ЧИТАТЕЛЬ на каждой поверхности. Сторож,
 * проверяющий только объявление, зеленеет ровно тогда, когда механизм
 * отвалился.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const CLIENT = read('lib/wishlist/client.ts');
const HOOK = read('hooks/use-wishlist.ts');

describe('долг: что сервер не подтвердил — записано отдельно', () => {
  it('два списка, и они разные: зеркало для показа, долг для досылки', () => {
    // По зеркалу не отличить подтверждённую отметку от неподтверждённой —
    // досылка гоняла бы к серверу всё подряд.
    expect(CLIENT).toMatch(/const LS_KEY = 'wishlist_local'/);
    expect(CLIENT).toMatch(/const PENDING_KEY = 'wishlist_pending'/);
  });

  it('офлайн пишет долг, подтверждение сервера его снимает', () => {
    const at = CLIENT.indexOf('export async function setWishlisted');
    const body = CLIENT.slice(at);
    // Успех: зеркало + снятие долга (он мог остаться от прежнего офлайна).
    // Проверяем ПОРЯДОК, а не число строк между: счёт строк сломался бы от
    // правки комментария, то есть краснел бы там, где механизм цел.
    const okAt = body.indexOf('if (res.ok && data.success !== false)');
    const forgetAt = body.indexOf('forgetPending(type, itemId);', okAt);
    const returnOkAt = body.indexOf('return { ok: true };', okAt);
    expect(okAt).toBeGreaterThan(-1);
    expect(forgetAt).toBeGreaterThan(okAt);
    expect(returnOkAt).toBeGreaterThan(forgetAt);
    // Офлайн: зеркало + долг, и исход назван localOnly, а не просто ok.
    expect(body).toMatch(/rememberPending\(type, itemId, on\);/);
    expect(body).toMatch(/return \{ ok: true, localOnly: true \};/);
  });

  it('один долг на предмет, а не один на нажатие', () => {
    // Пять нажатий без сети — это одно последнее состояние, а не пять запросов.
    expect(CLIENT).toMatch(/filter\(p => !\(p\.type === type && p\.id === id\)\)/);
  });

  it('досылка есть, делает ОДИН проход и не глотает отказ сервера', () => {
    expect(CLIENT).toMatch(/export async function flushPendingWishlist/);
    const at = CLIENT.indexOf('export async function flushPendingWishlist');
    const body = CLIENT.slice(at);
    // Гость (401) — долг снимается: висеть вечно он не должен.
    expect(body).toMatch(/res\.status === 401.*forgetPending/s);
    // Успех — снимается. Отказ сервера — ОСТАЁТСЯ (иначе это тот же дефект).
    expect(body).toMatch(/if \(res\.ok && data\.success !== false\)/);
    // Нет сети — проход прекращается, а не крутится штормом запросов.
    expect(body).toMatch(/\} catch \{[\s\S]*?break;/);
    // Повторов внутри нет: следующий `online` попробует снова.
    expect(body).not.toMatch(/while\s*\(/);
  });
});

describe('досылку кто-то зовёт — иначе она объявление без источника', () => {
  it('хук зовёт её и на online, и при монтировании', () => {
    expect(HOOK).toContain('flushPendingWishlist');
    // Событие `online` могло пройти при закрытой вкладке — тогда единственный
    // шанс догнать долг это следующее открытие страницы.
    expect(HOOK).toMatch(/window\.addEventListener\('online', flush\)/);
    expect(HOOK).toMatch(/window\.removeEventListener\('online', flush\)/);
    expect(HOOK).toMatch(/flush\(\);\s*\n\s*window\.addEventListener\('online', flush\)/);
  });

  it('хук отдаёт localOnly наружу и не приравнивает его к успеху', () => {
    expect(HOOK).toMatch(/localOnly: boolean;/);
    expect(HOOK).toMatch(/setLocalOnly\(res\.localOnly === true\)/);
    expect(HOOK).toMatch(/return \{ on, busy, error, localOnly, toggle \}/);
  });
});

describe('у состояния есть читатель на КАЖДОЙ поверхности', () => {
  /** Все компоненты, зовущие useWishlist — списком git, не перечнем руками. */
  function surfaces(): string[] {
    const out = execFileSync('git', ['-c', 'color.ui=false', 'grep', '-l', 'useWishlist(', '--', 'components', 'app'], {
      cwd: ROOT, encoding: 'utf-8',
    });
    return out.split('\n').filter(Boolean);
  }

  it('поверхности вообще есть (иначе тест зеленел бы на пустом списке)', () => {
    expect(surfaces().length).toBeGreaterThanOrEqual(6);
  });

  it('каждая читает localOnly — закрашенное сердце без сети значит не то же самое', () => {
    const silent: string[] = [];
    for (const f of surfaces()) {
      if (!read(f).includes('localOnly')) silent.push(f);
    }
    expect(silent, `Эти поверхности рисуют отметку, не различая «сохранено» и «сохранено только здесь»:\n${silent.join('\n')}`).toEqual([]);
  });

  it('формулировка одна на платформу, а не своя на каждом экране', () => {
    // Шесть формулировок одного состояния разъехались бы при первой правке —
    // тот же урок, что у линий карты (§12).
    expect(HOOK).toMatch(/export const WISHLIST_LOCAL_ONLY_HINT/);
    expect(HOOK).toMatch(/export function wishlistLabel/);
    for (const f of surfaces()) {
      expect(read(f), f).toMatch(/WISHLIST_LOCAL_ONLY_HINT|wishlistLabel/);
    }
  });
});
