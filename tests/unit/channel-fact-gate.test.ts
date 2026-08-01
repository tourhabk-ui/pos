/**
 * Фактчек — на ВСЕХ публикаторах новостных каналов, а не только на дайджесте.
 *
 * Инцидент 31.07: в публичный AI-канал ушёл пост intelligence-monitor с
 * перенесёнными числами («По данным Yandex YDB — ускоряет в 3 раза»,
 * «llama.cpp: прирост качества до 300%») и упоминанием TourHab. Гейты
 * unsourcedPercents/unsupportedClaims, построенные после инцидента 25.07,
 * жили только в scout-digest — конвейер intelligence-monitor →
 * postAINewsToChannel/postTravelNewsToChannel публиковал без проверки,
 * по 150-200-символьным огрызкам сниппетов, с внутренними action_items
 * («что сделать TourHab») в промпте публичного поста.
 *
 * Сторож держит: общий модуль, детерминированный гейт ловит кратности,
 * оба публикатора зовут гейт, внутренности не утекают в публичные посты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unsourcedPercents } from '@/lib/agents/fact-check';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('unsourcedPercents ловит и кратности, не только проценты', () => {
  it('«в 3 раза» без тройки в источнике — выдумка (кейс инцидента)', () => {
    expect(unsourcedPercents('YDB ускоряет обработку запросов в 3 раза', 'статья про кэширование запросов'))
      .toEqual(['в 3 раза']);
  });

  it('«300%» без числа в источнике — выдумка (кейс инцидента)', () => {
    expect(unsourcedPercents('прирост качества до 300%', 'speculative decoding ускоряет инференс'))
      .toEqual(['300%']);
  });

  it('число из источника — проходит (floor, а не семантика)', () => {
    expect(unsourcedPercents('ускорение в 3 раза', 'бенчмарк показал ускорение в 3 раза')).toEqual([]);
    expect(unsourcedPercents('на 40%', 'рост на 40 процентов... 40')).toEqual([]);
  });

  it('старый контракт дайджеста не сломан: пост без чисел чист', () => {
    expect(unsourcedPercents('Вышла новая модель, поддерживает инструменты', 'anything')).toEqual([]);
  });
});

describe('оба публикатора intelligence-monitor проходят гейт', () => {
  const src = code(read('lib/notifications/telegram-channel.ts'));

  it('postAINewsToChannel: гейт стоит перед публикацией', () => {
    const fn = src.slice(src.indexOf('function postAINewsToChannel'), src.indexOf('function postTravelNewsToChannel'));
    expect(fn, 'AI-канал снова публикует без фактчека')
      .toContain('factGatedText(postText, signalCtx, postPrompt)');
    expect(fn).toContain('Публикация отменена: факты поста не подтверждаются источниками');
  });

  it('postTravelNewsToChannel: гейт стоит перед публикацией', () => {
    const fn = src.slice(src.indexOf('function postTravelNewsToChannel'), src.indexOf('function parseRssItems'));
    expect(fn, 'travel-канал снова публикует без фактчека')
      .toContain('factGatedText(postText, signalCtx, postPrompt)');
  });

  it('гейт не прошёл — публикации нет (не фолбэк, а отмена)', () => {
    expect(src).toMatch(/if \(!gated\) \{/);
  });

  it('внутренние action_items не подаются в публичные посты', () => {
    const publicPart = src.slice(src.indexOf('function postAINewsToChannel'), src.indexOf('function parseRssItems'));
    expect(publicPart, 'внутренние рекомендации платформе снова утекают в публичный канал')
      .not.toMatch(/action_items\.join/);
    expect(publicPart).not.toMatch(/action_items\.map/);
  });

  it('сниппеты подаются целиком, а не 150-200-символьными огрызками', () => {
    const publicPart = src.slice(src.indexOf('function postAINewsToChannel'), src.indexOf('function parseRssItems'));
    expect(publicPart).not.toMatch(/snippet\.slice\(0, (?:150|200)\)/);
  });
});

describe('модуль общий, дайджест не отвязался', () => {
  it('scout-digest использует те же гейты из fact-check', () => {
    const src = code(read('lib/agents/scout-digest.ts'));
    expect(src).toMatch(/from '@\/lib\/agents\/fact-check'/);
    // Своих копий функций больше нет — одна реализация на всех.
    expect(src).not.toMatch(/function unsourcedPercents/);
    expect(src).not.toMatch(/function unsupportedClaims/);
  });
});

describe('склейка несвязанных источников — инцидент 01.08', () => {
  // Пост «Персистентная память для ИИ»: два несвязанных материала Habr
  // (агент Ouroboros и индексация Яндекса) были сшиты связками «Пример?»
  // и «А вот» в один сюжет, описание эксперимента подано как «доказал»,
  // а листикл «что это значит для бизнеса» требовал сам промпт публикатора.
  const factCheck = readFileSync(join(process.cwd(), 'lib/agents/fact-check.ts'), 'utf-8');
  const channel = readFileSync(join(process.cwd(), 'lib/notifications/telegram-channel.ts'), 'utf-8');

  it('судья проверяет СВЯЗКИ между источниками, а не только отдельные факты', () => {
    // Принцип в системном промпте судьи (не список кейсов): связь двух
    // фактов — тоже проверяемое утверждение.
    const sys = /system',\s*content:\s*'([^']+)'/.exec(code(factCheck))?.[1] ?? '';
    expect(sys, 'из промпта судьи пропал принцип проверки связок — склейка сюжетов вернётся')
      .toMatch(/СВЯЗ/);
    expect(sys).toMatch(/один сюжет|общий вывод/);
  });

  it('промпты публикаторов не требуют выдумывать «практический вывод»', () => {
    // Требование «что это значит для бизнеса» / «как влияет на туры» само
    // приглашало модель фантазировать выводы, которых нет в источниках.
    expect(channel, 'в промпт вернулось требование практического вывода — приглашение к выдумке')
      .not.toMatch(/Практический вывод/);
    // Вместо него — явное разрешение закончить фактами.
    expect(channel).toMatch(/пост\s+заканчивается\s+фактами/);
  });
});

describe('числовой гейт ловит цены, не только проценты (дайджест 01.08)', () => {
  it('цена в долларах, которой нет в источнике, — выдумка', () => {
    // Реальный кейс: пост «$0.27 за выход», источник — «$0.28».
    expect(unsourcedPercents('Цена: $0.14 вход и $0.27 выход', 'DeepSeek: $0.14 input, $0.28 output'))
      .toContain('$0.27');
  });

  it('цена, совпадающая с источником, проходит', () => {
    expect(unsourcedPercents('$0.14 за миллион токенов входа', 'input $0.14 per 1M tokens'))
      .toEqual([]);
  });

  it('рубли с разделителем тысяч ловятся', () => {
    // «от 68 000 ₽», которого нет в источнике.
    const bad = unsourcedPercents('Тур от 68 000 ₽', 'оператор указал цену 72 000 ₽');
    expect(bad.some((c) => c.includes('68'))).toBe(true);
  });

  it('валюта из источника не помечается', () => {
    expect(unsourcedPercents('стоит 990 руб', 'цена 990 руб за вход')).toEqual([]);
  });
})
