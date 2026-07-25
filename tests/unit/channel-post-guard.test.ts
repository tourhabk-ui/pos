/**
 * В канал не уходит то, что постом не является.
 *
 * Инцидент 25.07.2026: в канал (3.1К подписчиков) опубликовался пост
 * «Сервис временно недоступен.». Это не сообщение об ошибке, которое кто-то
 * написал руками, — это ЗАГЛУШКА waterfall: при отказе всех LLM-провайдеров
 * `callAIFast`/`callAIWaterfall` возвращают строку, а не бросают исключение.
 * Публикатор принял её за готовый текст.
 *
 * Два вывода, оба зашиты здесь.
 *
 * 1. Ловить это длиной нельзя. У callAIFast заглушка 27 символов и не проходит
 *    порог в 30 СЛУЧАЙНО. У callAIWaterfall — 54 символа, и порог она проходит.
 *    Значит нужен реестр заглушек, а не эвристика.
 *
 * 2. Валидация не должна быть обязанностью публикатора. Модуль post-validation
 *    существовал и требовал «каждый пост ОБЯЗАН пройти валидацию», но звать её
 *    нужно было вручную — и один публикатор не позвал. Проверка перенесена в
 *    саму точку публикации, через которую идут все.
 */
import { describe, it, expect } from 'vitest';
import { blockingTextIssue } from '@/lib/notifications/post-validation';
import { AI_FAST_UNAVAILABLE, isWaterfallErrorResponse } from '@/lib/ai/providers';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('заглушка отказа AI не становится постом', () => {
  it('заглушка callAIFast отвергается', () => {
    const issue = blockingTextIssue(AI_FAST_UNAVAILABLE);
    expect(issue).toContain('заглушка');
  });

  it('заглушка callAIWaterfall отвергается — её длины хватило бы на пост', () => {
    const long = 'Извините, сервис временно недоступен. Попробуйте позже.';
    // Именно этот случай прежняя проверка длины пропустила бы.
    expect(long.length).toBeGreaterThan(30);
    expect(blockingTextIssue(long)).toContain('заглушка');
  });

  it('обе заглушки опознаются общим реестром providers.ts', () => {
    // Один источник правды: если там добавят третью, гвард узнает сам.
    expect(isWaterfallErrorResponse(AI_FAST_UNAVAILABLE)).toBe(true);
  });

  it('заглушка в HTML-обёртке тоже отвергается', () => {
    expect(blockingTextIssue(`<b>${AI_FAST_UNAVAILABLE}</b>`)).toContain('заглушка');
  });
});

describe('прочие негодные тексты', () => {
  it('пустой и пробельный не публикуются', () => {
    expect(blockingTextIssue('')).toContain('пустой');
    expect(blockingTextIssue('   \n  ')).toContain('пустой');
    expect(blockingTextIssue('<b></b>')).toContain('пустой');
  });

  it('слишком короткий не публикуется', () => {
    expect(blockingTextIssue('Коротко')).toContain('короткий');
  });

  it('слишком длинный не публикуется', () => {
    expect(blockingTextIssue('а'.repeat(2001))).toContain('длинный');
  });

  it('нормальный пост проходит', () => {
    const good =
      'Авачинский вулкан открыт для восхождения. Выход с приюта в 6 утра, ' +
      'подъём занимает около шести часов. Регистрация в МЧС обязательна.';
    expect(blockingTextIssue(good)).toBeNull();
  });
});

describe('проверка стоит в самой точке публикации', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/notifications/telegram-channel.ts'), 'utf-8');

  it('postToAllChannels спрашивает blockingTextIssue до отправки', () => {
    const body = SRC.match(/async function postToAllChannels[\s\S]*?\n\}/)?.[0] ?? '';
    expect(body).not.toBe('');
    expect(body).toMatch(/blockingTextIssue\(text\)/);

    // И именно ДО вызова отправки, а не после.
    const guardAt = body.indexOf('blockingTextIssue');
    const sendAt = Math.min(
      ...[body.indexOf('tgPost('), body.indexOf('tgPostPhoto(')].filter((i) => i >= 0),
    );
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(sendAt);
  });

  /**
   * Урок инцидента, который дороже самого инцидента.
   *
   * Гвард сначала поставили в postToAllChannels, считая её единственной точкой
   * выхода. Она ею не была: postAINewsToChannel звал tgPostPhoto напрямую — и
   * это ровно тот публикатор, который отправил заглушку в AI-канал. «Единая
   * точка» держалась на вере, что все ходят через неё.
   *
   * Здесь эта вера заменена проверкой: любой публикатор, который сам зовёт
   * tgPost/tgPostPhoto, обязан сам же спросить blockingTextIssue. Забыть
   * теперь нельзя — тест назовёт имя функции.
   */
  it('ни один публикатор не шлёт в обход гварда', () => {
    const offenders: string[] = [];
    const fnRe = /export async function (post\w+)\(([\s\S]*?)\n\}/g;

    for (const m of SRC.matchAll(fnRe)) {
      const [, name, body] = m;
      const sendsDirectly = /\btgPost(Photo)?\(/.test(body);
      if (!sendsDirectly) continue; // идёт через postToAllChannels — уже закрыт
      if (!body.includes('blockingTextIssue')) offenders.push(name);
    }

    expect(
      offenders,
      `публикуют напрямую без проверки текста: ${offenders.join(', ')}. ` +
        'Позовите blockingTextIssue перед отправкой либо публикуйте через postToAllChannels.',
    ).toEqual([]);
  });
});
