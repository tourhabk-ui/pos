/**
 * «Поделиться» и реферальная ссылка.
 *
 * Два дефекта, оба одного рода — обещание без исполнения.
 *
 * ПЕРВЫЙ. Кнопок «поделиться» было четыре, и вели они себя по-разному:
 * карточка тура при отсутствии `navigator.share` не делала НИЧЕГО, лист места
 * копировал ссылку молча (снаружи неотличимо от отказа), кабинет лояльности
 * ронял AbortError при отмене листа, и лишь шапка места вела себя правильно.
 *
 * ВТОРОЙ, дороже. Ссылку вида `?ref=КОД` собирали в четырёх местах — и не
 * читал её НИКТО. Форма регистрации не отправляла `referralCode`, хотя
 * `POST /api/auth/register` его принимает. Приглашающий получал ссылку,
 * которая выглядит реферальной и не приводит ни одного реферала.
 *
 * Поэтому сторож проверяет не наличие кнопки, а замкнутость пути: поймали код
 * → сохранили → отдали при регистрации.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { shareOutcomeMessage, shareLink } from '@/lib/share';
import {
  isUserReferralCode,
  withReferral,
  readReferralFromSearch,
  saveReferral,
  loadReferral,
  forgetReferral,
  REFERRAL_TTL_MS,
} from '@/lib/referral/link';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Исходник без комментариев — чтобы гард судил код, а не прозу о коде. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('исход «поделиться» всегда назван', () => {
  it('копирование требует отклика, отказ — тоже', () => {
    expect(shareOutcomeMessage('copied')).toBeTruthy();
    expect(shareOutcomeMessage('unavailable')).toBeTruthy();
  });

  it('успех и отмена молчат', () => {
    // Системный лист человек видел сам; отмена — его собственное решение.
    expect(shareOutcomeMessage('shared')).toBeNull();
    expect(shareOutcomeMessage('cancelled')).toBeNull();
  });
});

describe('shareLink разбирает случаи, а не глотает их', () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const original = { share: nav.share, clipboard: nav.clipboard };

  afterEach(() => {
    Object.defineProperty(nav, 'share', { value: original.share, configurable: true });
    Object.defineProperty(nav, 'clipboard', { value: original.clipboard, configurable: true });
  });

  function setNav(share: unknown, clipboard: unknown) {
    Object.defineProperty(nav, 'share', { value: share, configurable: true });
    Object.defineProperty(nav, 'clipboard', { value: clipboard, configurable: true });
  }

  it('лист принял — shared', async () => {
    setNav(vi.fn().mockResolvedValue(undefined), undefined);
    expect(await shareLink({ title: 'т', url: 'https://vedarai.ru/' })).toBe('shared');
  });

  it('человек закрыл лист — cancelled, и в буфер НЕ лезем', async () => {
    // Иначе отмена оборачивалась бы «ссылка скопирована»: человек передумал,
    // а мы отчитались об успехе.
    const writeText = vi.fn().mockResolvedValue(undefined);
    const abort = new DOMException('cancelled', 'AbortError');
    setNav(vi.fn().mockRejectedValue(abort), { writeText });
    expect(await shareLink({ title: 'т', url: 'https://vedarai.ru/' })).toBe('cancelled');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('листа нет (десктоп) — copied, а не тишина', async () => {
    // Ровно тот случай, когда карточка тура не делала ничего.
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav(undefined, { writeText });
    expect(await shareLink({ title: 'т', url: 'https://vedarai.ru/x' })).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('https://vedarai.ru/x');
  });

  it('лист упал не отменой — падаем в буфер, а не сдаёмся', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav(vi.fn().mockRejectedValue(new Error('вебвью')), { writeText });
    expect(await shareLink({ title: 'т', url: 'https://vedarai.ru/' })).toBe('copied');
  });

  it('нет ни листа, ни буфера — unavailable, и это будет сказано', async () => {
    setNav(undefined, undefined);
    expect(await shareLink({ title: 'т', url: 'https://vedarai.ru/' })).toBe('unavailable');
  });
});

describe('реферальный код отличается от агентского', () => {
  it('свой формат принимается', () => {
    expect(isUserReferralCode('KH-A1B2C3')).toBe(true);
  });

  it('чужой код не принимается', () => {
    // `?ref=` на платформе занят дважды: кроме users.referral_code есть
    // agent_referral_links (читаются в /api/tours/[id]/price). Это разные
    // сущности с разными выплатами, путать их нельзя.
    expect(isUserReferralCode('PARTNER2026')).toBe(false);
    expect(isUserReferralCode('KH-ZZZZZZ')).toBe(false);
    expect(isUserReferralCode(null)).toBe(false);
  });
});

describe('сборка ссылки', () => {
  it('код приписывается', () => {
    expect(withReferral('https://vedarai.ru/', 'KH-A1B2C3')).toContain('ref=KH-A1B2C3');
  });

  it('чужой параметр не теряется и второго «?» не появляется', () => {
    const out = withReferral('https://vedarai.ru/routes?q=узон', 'KH-A1B2C3');
    expect(out).toContain('q=');
    expect(out.match(/\?/g)?.length).toBe(1);
  });

  it('без кода ссылка не меняется', () => {
    expect(withReferral('https://vedarai.ru/', null)).toBe('https://vedarai.ru/');
  });

  it('из строки запроса читается только свой код', () => {
    expect(readReferralFromSearch('?ref=kh-a1b2c3')).toBe('KH-A1B2C3');
    expect(readReferralFromSearch('?ref=PARTNER2026')).toBeNull();
    expect(readReferralFromSearch('')).toBeNull();
  });
});

describe('код доживает до регистрации, но не дольше срока', () => {
  beforeEach(() => forgetReferral());

  it('сохранён — читается', () => {
    saveReferral('KH-A1B2C3', 1_000_000);
    expect(loadReferral(1_000_000 + 60_000)).toBe('KH-A1B2C3');
  });

  it('протух — забыт', () => {
    // Полугодовой давности код приписал бы приглашение тому, кто к решению
    // отношения уже не имеет.
    saveReferral('KH-A1B2C3', 1_000_000);
    expect(loadReferral(1_000_000 + REFERRAL_TTL_MS + 1)).toBeNull();
    expect(loadReferral(1_000_000 + 60_000)).toBeNull();
  });
});

describe('путь приглашения замкнут', () => {
  it('код ловится на любой странице, а не только на главной', () => {
    expect(read('app/layout.tsx')).toMatch(/<ReferralCapture \/>/);
  });

  it('регистрация отправляет пойманный код', () => {
    // Ради этой строки всё и делалось: без неё ссылка декоративна.
    const src = read('app/auth/login/_AuthPageClient.tsx');
    expect(src).toMatch(/loadReferral\(Date\.now\(\)\)/);
    expect(src).toMatch(/referralCode: referralCode \?\? undefined/);
  });

  it('код забывается только после удачной регистрации', () => {
    // Забыть до ответа сервера значило бы потерять приглашение из-за опечатки
    // в пароле.
    const src = read('app/auth/login/_AuthPageClient.tsx');
    expect(src.indexOf('if (referralCode) forgetReferral()')).toBeGreaterThan(
      src.indexOf('Ошибка регистрации')
    );
  });
});

describe('реализация одна', () => {
  it('navigator.share живёт только в lib/share.ts', () => {
    // Четыре копии уже разъехались поведением. Пятая копия — это пятое
    // поведение, а не пятая кнопка.
    const candidates = execFileSync(
      'git',
      // --untracked обязателен: без него git grep не видит ещё не
      // добавленные файлы, и проверка «реализация одна» проходила бы вхолостую
      // именно в тот момент, когда реализацию добавляют.
      ['grep', '-l', '--untracked', 'navigator.share', '--', 'app', 'components', 'lib', 'hooks'],
      { encoding: 'utf-8' },
    )
      .split('\n')
      .filter(Boolean);

    // Комментарий, ОБЪЯСНЯЮЩИЙ снятую конструкцию, — не нарушение. Гард,
    // который этого не различает, запрещает описывать собственные правки; за
    // сессию он спотыкался об это пять раз.
    const inCode = candidates.filter((f) =>
      stripComments(read(f)).includes('navigator.share'),
    );
    expect(inCode).toEqual(['lib/share.ts']);
  });

  it('домен реферальной ссылки не пишется руками', () => {
    const api = read('app/api/loyalty/referral/route.ts');
    expect(api).toMatch(/withReferral\(getPublicBaseUrl\(\)/);
    expect(api).not.toMatch(/https:\/\/vedarai\.ru\/\?ref=/);
  });
});

describe('кнопка на главной есть на обоих деревьях', () => {
  it('мобильное дерево', () => {
    // Главная рендерится двумя разными деревьями по User-Agent. Кнопка в одном
    // из них — это кнопка, которой у половины людей нет.
    expect(read('app/_home/_HomeV8Client.tsx')).toMatch(/<ShareButton/);
  });

  it('десктопное дерево', () => {
    expect(read('components/homepage/HeroStatus.tsx')).toMatch(/<ShareButton/);
  });

  it('на обоих ссылка реферальная', () => {
    expect(read('app/_home/_HomeV8Client.tsx')).toMatch(/referral\s/);
    expect(read('components/homepage/HeroStatus.tsx')).toMatch(/referral\s/);
  });
});
