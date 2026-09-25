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
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HELP_ARTICLES, TOURISTS, OPERATORS, GUIDES, SUPPORT } from '@/lib/help/content';
import { PAYABLE_BOOKING_STATUSES } from '@/lib/bookings/success-view';

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

  it('оплата открывается только после подтверждения оператором', () => {
    // Правило, которое справка пересказывает, действительно такое.
    expect(PAYABLE_BOOKING_STATUSES).not.toContain('new');
    expect(text).toMatch(/оплата открывается, только когда оператор подтвердил/i);
  });

  it('нет прежних выдумок', () => {
    for (const lie of [/мгновенно/i, /более 7 дней/i, /1189/, /промокод/i, /баллы лояльности/i]) {
      expect(text).not.toMatch(lie);
    }
  });

  it('возврат — по условиям тура, отмена оператором — 100%', () => {
    expect(text).toMatch(/Отменил оператор — 100%/);
    expect(text).toMatch(/условий тура/);
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

describe('контакты поддержки — те же, что на сайте', () => {
  it('адрес совпадает с футером', () => {
    expect(read('components/layout/Footer.tsx')).toContain(SUPPORT.email);
  });

  it('раздел гидов есть в навигации и карте сайта', () => {
    expect(read('lib/navigation/platform-links.ts')).toContain("'/help/guides'");
    expect(read('lib/seo/sitemap-entries.ts')).toContain('/help/guides');
  });
});
