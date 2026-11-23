/**
 * Справка не обещает того, чего система не делает (26.09).
 *
 * Прежние страницы /help писались до того, как платформа стала такой, какая
 * есть, и расходились с ней в самом дорогом месте — в деньгах: «подтверждение
 * приходит мгновенно» после оплаты (оплата открывается только после
 * подтверждения оператором, lib/bookings/success-view.ts), своя шкала
 * возврата «более 7 дней — полный возврат» (возврат считается по условиям
 * конкретного тура, lib/payments/tour-refund.ts).
 *
 * Сторож держит связку: страницы берут текст только из lib/help/content.ts,
 * а в тексте нет прежних выдумок и есть то, на чём держится доверие.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HELP_ARTICLES, TOURISTS, OPERATORS, GUIDES, SUPPORT } from '@/lib/help/content';
import { PAYABLE_BOOKING_STATUSES } from '@/lib/bookings/success-view';
import { PLATFORM_ACCEPTS_PAYMENTS } from '@/lib/payments/accepting';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const allText = (a: (typeof HELP_ARTICLES)[number]) => JSON.stringify(a);

describe('страницы справки берут текст из одного места', () => {
  for (const slug of ['tourists', 'operators', 'guides']) {
    it(`/help/${slug}`, () => {
      const src = read(`app/help/${slug}/page.tsx`);
      expect(src).toMatch(/from '@\/lib\/help\/content'/);
      expect(src).toMatch(/HelpArticleView/);
    });
  }

  it('прежних клиентских страниц с отдельным текстом нет', () => {
    expect(existsSync(join(process.cwd(), 'app/help/tourists/_TouristsHelpClient.tsx'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'app/help/operators/_OperatorsHelpClient.tsx'))).toBe(false);
  });
});

describe('туристу: оплата после подтверждения, возврат по условиям тура', () => {
  const text = allText(TOURISTS);

  it('оплата: справка говорит то, что делает код (выключатель lib/payments/accepting)', () => {
    // Правило, которое справка пересказывает, действительно такое.
    expect(PAYABLE_BOOKING_STATUSES).not.toContain('new');
    if (PLATFORM_ACCEPTS_PAYMENTS) {
      expect(text).toMatch(/оплата открывается, только когда оператор подтвердил/i);
    } else {
      // Решение владельца 05.10: платформа оплату не принимает. Справка не
      // зовёт к кнопке, которой нет, и не обещает возврат от платформы.
      expect(text).toMatch(/Ведар платежи не принимает/);
      expect(text).toMatch(/оператору напрямую/);
      for (const gone of [/CloudPayments/, /QR/, /Перейти к оплате/, /хранятся у платформы/, /администрация[^.]*вручную/i]) {
        expect(text).not.toMatch(gone);
      }
    }
  });

  it('нет прежних выдумок', () => {
    for (const lie of [/мгновенно/i, /более 7 дней/i, /1189/, /промокод/i, /баллы лояльности/i]) {
      expect(text).not.toMatch(lie);
    }
  });

  it('возврат — по условиям тура', () => {
    if (PLATFORM_ACCEPTS_PAYMENTS) expect(text).toMatch(/Отменил оператор — 100%/);
    else expect(text).toMatch(/возвращает их тоже оператор/);
    expect(text).toMatch(/услови\S* отмены/);
  });

  it('SOS и 112 названы', () => {
    expect(text).toMatch(/112/);
    expect(text).toMatch(/SOS/);
  });
});

describe('оператору и гиду', () => {
  it('оператору: регистрация группы в МЧС — самостоятельно', () => {
    expect(allText(OPERATORS)).toContain('forms.mchs.gov.ru');
    expect(allText(OPERATORS)).not.toMatch(/автоматически (регистрир|отправ)/i);
  });

  it('гиду: начисления на платформе не обещаны', () => {
    expect(allText(GUIDES)).toMatch(/Начисления гидам на платформе пока не ведутся/);
  });
});

/**
 * Деньги оператора — по выключателю оплаты, в обе стороны (план готовности
 * 23.11, этап 1). Блок «Деньги» говорил «платежи не принимаем», а вопрос
 * строкой ниже обещал выплату через 36 часов: выключатель стоял у одного из
 * двух. Справка собирается при импорте модуля, поэтому каждое положение
 * выключателя — свой импорт.
 */
describe('оператору: деньги по выключателю оплаты', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/payments/accepting');
    vi.resetModules();
  });

  const operatorsWith = async (accepts: boolean) => {
    vi.resetModules();
    vi.doMock('@/lib/payments/accepting', () => ({
      PLATFORM_ACCEPTS_PAYMENTS: accepts,
      platformAcceptsPayments: () => accepts,
    }));
    const { OPERATORS: article } = await import('@/lib/help/content');
    return { article, text: JSON.stringify(article) };
  };
  const moneyAnswer = (article: typeof OPERATORS) => article.faq.find((f) => f.q === 'Когда я получу деньги?')?.a;

  it('оплата выключена: ни блок, ни вопрос не обещают выплату — турист платит напрямую', async () => {
    const { article, text } = await operatorsWith(false);
    for (const promise of [/формирует выплату/, /36 час/, /из раздела «Финансы»/, /к выплате/, /удерживаются/]) {
      expect(text, String(promise)).not.toMatch(promise);
    }
    expect(text).toMatch(/платежи туристов платформа не принимает/);
    const answer = moneyAnswer(article);
    expect(answer, 'вопрос о деньгах остаётся, с честным ответом').toBeDefined();
    expect(answer).toMatch(/платит вам напрямую/);
    expect(answer).toMatch(/выплат от платформы нет/);
  });

  it('оплата включена: ветка выплаты не удалена — блок и вопрос говорят одно', async () => {
    const { article, text } = await operatorsWith(true);
    expect(moneyAnswer(article)).toMatch(/36 часов администрация формирует выплату/);
    expect(text).toMatch(/удерживаются до окончания тура \+ 36 часов/);
    expect(text).not.toMatch(/выплат от платформы нет/);
  });

  it('на деле сейчас: справка совпадает с положением выключателя в коде', () => {
    const answer = moneyAnswer(OPERATORS) ?? '';
    if (PLATFORM_ACCEPTS_PAYMENTS) expect(answer).toMatch(/формирует выплату/);
    else expect(answer).toMatch(/платит вам напрямую/);
  });
});

describe('оператору: MAX подключается из кабинета, не по почте', () => {
  const text = allText(OPERATORS);

  it('команды «партнер» + email нет; есть кабинет, «Подключить MAX» и «Старт»', () => {
    expect(text).not.toMatch(/напишите боту[^.]*партн[её]р/i);
    expect(text).not.toMatch(/email из профиля/i);
    for (const word of ['вверху кабинета', '«Подключить MAX»', '«Подключить Telegram»', '«Старт»']) {
      expect(text, word).toContain(word);
    }
    expect(text).toContain('По почте чат не подключается');
  });
});

describe('контакты поддержки — те же, что на сайте', () => {
  it('адрес совпадает с футером', () => {
    expect(read('components/layout/Footer.tsx')).toContain(SUPPORT.email);
  });

  it('раздел гидов есть в навигации и карте сайта', () => {
    expect(read('lib/navigation/platform-links.ts')).toContain("'/help/guides'");
    expect(read('lib/seo/sitemap-entries.ts')).toContain('/help/guides');
  });
});
