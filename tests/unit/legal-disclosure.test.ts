/**
 * Что грузится — то и объявлено; кто мы — записано один раз.
 *
 * ── Что нашёл разбор права 11.09 (docs/LEGAL.md) ──────────────────────────
 *
 * 1. ТРИ сторонних скрипта грузились на КАЖДОЙ странице безусловно, до любого
 *    вопроса посетителю. Баннера согласия в репозитории не было ни одного.
 * 2. `MicrosoftClarity` (запись сессий, Microsoft, США) не был назван в
 *    политике конфиденциальности НИ РАЗУ — то есть получатель данных, о
 *    котором человек узнать не мог.
 * 3. `TravelPayoutsDrive` подменяет ссылки на партнёрские и показывает
 *    «таргетированные предложения» — это рекламное размещение, а токена erid
 *    у него нет (38-ФЗ ст. 18.1).
 * 4. Реквизиты юрлица стояли девятью вхождениями в пяти страницах. Совпадали
 *    по удаче: сменится адрес — часть страниц останется со старым, а это то,
 *    КОМУ человек платит и к кому идёт с претензией (ЗоЗПП ст. 10).
 *
 * Механизм один и знакомый: объявление (политика, докстрока) живёт отдельно
 * от механизма (тег в разметке), и расходятся они молча. Поэтому здесь не
 * «проверить текст политики», а связка: один реестр кормит И загрузку, И
 * страницу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { THIRD_PARTIES, loadDecision, crossBorderRecipients } from '@/lib/legal/third-party-registry';
import { REQUISITES } from '@/lib/legal/requisites';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const LEGAL_PAGES = [
  'app/legal/offer/page.tsx',
  'app/legal/terms/page.tsx',
  'app/legal/privacy/page.tsx',
  'app/legal/commission/page.tsx',
  'app/legal/agent-agreement/page.tsx',
];

describe('реквизиты юрлица — из одного источника', () => {
  it.each(LEGAL_PAGES)('%s не пишет ИНН и ОГРН руками', (f) => {
    const code = strip(read(f));
    expect(code, 'ИНН вписан в страницу — при смене разойдётся с остальными')
      .not.toContain(REQUISITES.inn);
    expect(code, 'ОГРН вписан в страницу').not.toContain(REQUISITES.ogrn);
  });

  it.each(LEGAL_PAGES)('%s берёт реквизиты из lib/legal/requisites', (f) => {
    expect(read(f)).toMatch(/from '@\/lib\/legal\/requisites'/);
  });

  it('источник называет себя как записано у нас, а не как проверенный факт', () => {
    // Значения перенесены со страниц, а не сверены с ЕГРЮЛ. Честность про
    // происхождение — часть правила §4.0: «не знаю» обязано называться.
    const src = read('lib/legal/requisites.ts');
    expect(src).toMatch(/ЕГРЮЛ/);
    expect(src).toMatch(/не проверил|за владельцем/);
  });
});

describe('сторонние скрипты: объявление и механизм — один источник', () => {
  it('layout не монтирует трекеры поштучно и безусловно', () => {
    const layout = strip(read('app/layout.tsx'));
    for (const gone of ['YandexMetrika', 'MicrosoftClarity', 'TravelPayoutsDrive']) {
      expect(layout, `${gone} снова смонтирован напрямую — мимо согласия`).not.toMatch(
        new RegExp(`<${gone}\\s*/>`),
      );
    }
    expect(layout).toMatch(/<ThirdPartyScripts\s*\/>/);
  });

  it('прежние компоненты-одиночки удалены, а не оставлены дублем', () => {
    for (const f of [
      'components/shared/YandexMetrika.tsx',
      'components/shared/MicrosoftClarity.tsx',
      'components/shared/TravelPayoutsDrive.tsx',
    ]) {
      expect(existsSync(join(ROOT, f)), `${f} вернулся — расходящийся дубль загрузки`).toBe(false);
    }
  });

  it('политика перечисляет получателей ИЗ реестра, а не своим списком', () => {
    const privacy = read('app/legal/privacy/page.tsx');
    expect(privacy).toMatch(/from '@\/lib\/legal\/third-party-registry'/);
    expect(privacy).toMatch(/THIRD_PARTIES\.map/);
    // Прежний рукописный список получателей не должен вернуться: он и
    // разошёлся с реальностью (Clarity там не было вовсе).
    expect(privacy, 'рукописный перечень вернулся — он и был причиной расхождения')
      .not.toMatch(/<strong>Яндекс\.Метрика<\/strong>/);
  });

  it('трансграничные получатели названы отдельно — это отдельный факт', () => {
    expect(crossBorderRecipients().length).toBeGreaterThan(0);
    expect(read('app/legal/privacy/page.tsx')).toMatch(/crossBorderRecipients\(\)/);
  });
});

describe('согласие: «не спрашивали» не равно «разрешил»', () => {
  it('без согласия не грузится ничего', () => {
    const none = { analytics: false, advertising: false };
    const loaded = THIRD_PARTIES.filter((t) => loadDecision(t, none).load);
    expect(loaded, `грузится без согласия: ${loaded.map((t) => t.id).join(', ')}`).toEqual([]);
  });

  it('аналитика грузится по согласию на аналитику, реклама — нет', () => {
    const onlyAnalytics = { analytics: true, advertising: false };
    const ids = THIRD_PARTIES.filter((t) => loadDecision(t, onlyAnalytics).load).map((t) => t.id);
    expect(ids).toContain('YandexMetrika');
    expect(ids).toContain('MicrosoftClarity');
    expect(ids, 'рекламное размещение поехало по согласию на аналитику').not.toContain('TravelPayoutsDrive');
  });

  it('реклама без erid не грузится ДАЖЕ с согласия', () => {
    // Маркировка — требование к размещению (38-ФЗ ст. 18.1), а не к
    // посетителю: согласием её не заменить. Токен выдаёт ОРД, и подставить
    // сюда выдуманную строку значило бы подделать маркировку.
    const all = { analytics: true, advertising: true };
    for (const tp of THIRD_PARTIES.filter((t) => t.isAdvertising && !t.erid)) {
      const d = loadDecision(tp, all);
      expect(d.load, `${tp.id}: реклама без токена erid не должна грузиться`).toBe(false);
      if (!d.load) expect(d.reason).toMatch(/erid/);
    }
  });

  it('неизвестное состояние согласия трактуется как отказ', () => {
    const src = strip(read('lib/legal/consent.ts'));
    expect(src).toMatch(/state: 'unknown'/);
    // Отказ хранилища — это «не знаю», и оно не должно молчать (§4.0).
    expect(src).toMatch(/console\.error\('\[consent\]/);
  });
});

describe('проверка гейта существует и ВЫЗЫВАЕТСЯ (правило 10.09)', () => {
  // Текстовые сторожа выше судят ФОРМУ кода: реестр один, баннер непрозрачный,
  // трекеры не смонтированы напрямую. Ни один из них не доказывает, что на
  // живом проде до согласия наружу не уходит ни байта — это поведение, и
  // доказывает его только браузер. Здесь держится связка: проба есть, берёт
  // хосты из реестра и РЕАЛЬНО запускается в workflow. Проба, объявленная и
  // не вызванная, — ровно тот дефект, ради которого правило и записано.
  const SPEC = 'test/e2e/consent-gate.spec.ts';

  it('браузерная проба гейта заведена', () => {
    expect(existsSync(join(ROOT, SPEC)), `${SPEC} исчезла — поведение гейта снова никем не проверено`).toBe(true);
  });

  it('проба берёт хосты и ключ согласия из источника, а не своим списком', () => {
    const src = read(SPEC);
    expect(src).toMatch(/from '\.\.\/\.\.\/lib\/legal\/third-party-registry'/);
    expect(src).toMatch(/CONSENT_STORAGE_KEY/);
    // Список хостов обязан ВЫЧИСЛЯТЬСЯ из реестра, а не стоять литералом.
    expect(src, 'TRACKED_HOSTS перестал считаться из реестра').toMatch(
      /TRACKED_HOSTS\s*=\s*THIRD_PARTIES\.map/,
    );
    // И ни один хост не вписан в пробу строкой. Исключение одно и намеренное —
    // Метрика в положительном контроле: там хост назван именно потому, что
    // проверяется попадание в КОНКРЕТНЫЙ сервис, а не «хоть куда-то».
    const handwritten = THIRD_PARTIES
      .filter((tp) => tp.id !== 'YandexMetrika')
      .map((tp) => tp.host)
      .filter((host) => src.includes(`'${host}'`) || src.includes(`"${host}"`));
    expect(handwritten, 'хост вписан в пробу руками — разойдётся с реестром').toEqual([]);
  });

  it('у пробы есть положительный контроль: она умеет не только НЕ находить', () => {
    // Счётчик запросов, который сломался, молчит одинаково при рабочем и при
    // дырявом гейте. Ветка согласия обязана требовать реального попадания.
    expect(read(SPEC)).toMatch(/toContain\('mc\.yandex\.ru'\)/);
  });

  it('workflow действительно гоняет пробу', () => {
    const wf = read('.github/workflows/e2e-smoke.yml');
    expect(wf, 'проба заведена, но не вызывается — объявление без источника').toContain(SPEC);
  });
});

describe('баннер согласия — действие, а не украшение (DS §5)', () => {
  const BANNER = read('components/legal/ThirdPartyScripts.tsx');

  it('непрозрачный: решение о своих данных читается при любом фоне', () => {
    expect(BANNER).toMatch(/bg-\[var\(--bg-card\)\]/);
    expect(BANNER, 'стекло на действии запрещено').not.toMatch(/backdrop-blur/);
  });

  it('обе кнопки — настоящие тач-цели', () => {
    const targets = BANNER.match(/min-h-\[44px\]/g) ?? [];
    expect(targets.length).toBeGreaterThanOrEqual(2);
  });

  it('называет, что происходит, и ведёт в политику', () => {
    expect(BANNER).toMatch(/за пределы\s*\n?\s*России|за пределы России/);
    expect(BANNER).toMatch(/\/legal\/privacy/);
  });
});
