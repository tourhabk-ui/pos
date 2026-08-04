/**
 * Сторож СТАНДАРТА карточки тура (CLAUDE.md §11).
 *
 * Повод: карточка тура рисовалась несколькими разными способами, и в макете,
 * присланном владельцем, было три вещи, которые нельзя пускать в прод:
 *   1. своя SOS-кнопка (копия расходится поведением с EmergencyAction —
 *      это уже случалось, см. components/shared/EmergencyAction.tsx);
 *   2. ЗАХАРДКОЖЕННЫЕ правила безопасности (правда для сплава, ложь для
 *      рыбалки/вертолёта) — теперь только из operator_tours.safety_notes;
 *   3. выдуманные поля данных вместо существующих источников.
 *
 * Этот сторож фиксирует стандарт, чтобы он не разъехался снова.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CARD = join(process.cwd(), 'app/marketplace/tours/[id]/_TourDetailClient.tsx');
const src = readFileSync(CARD, 'utf-8');

const catalogPage = readFileSync(join(process.cwd(), 'app/catalog/tours/[id]/page.tsx'), 'utf-8');
const marketPage = readFileSync(join(process.cwd(), 'app/marketplace/tours/[id]/page.tsx'), 'utf-8');

/** SQL карточки живёт В ОДНОМ месте — копии в двух страницах уже разъезжались. */
const query = readFileSync(join(process.cwd(), 'lib/tours/tour-detail-query.ts'), 'utf-8');

describe('стандарт карточки тура — безопасность', () => {
  it('НЕ содержит своей SOS-кнопки (единственная реализация — EmergencyAction)', () => {
    expect(src).not.toMatch(/href=["']\/sos["']/);
    expect(src).not.toMatch(/aria-label=["']SOS/i);
    expect(src).not.toMatch(/>\s*SOS\s*</);
  });

  it('правила безопасности приходят из данных, а не захардкожены', () => {
    expect(src).toContain('safety_notes');
    // характерные строки макета не должны быть вшиты в компонент
    expect(src).not.toContain('спасательные жилеты');
    expect(src).not.toContain('Алкоголь до и во время');
    expect(src).not.toContain('уровня воды');
    // «Наблюдение за медведями» как ЯРЛЫК типа тура — легально; как ПРАВИЛО — нет
    expect(src).not.toContain('безопасной дистанции');
    expect(src).not.toContain('по указанию гида');
  });

  it('запрос карточки отдаёт safety_notes и program', () => {
    expect(query).toContain('ot.program');
    expect(query).toContain('ot.safety_notes');
  });

  it('обе страницы читают тур ОДНИМ общим запросом, без своего SQL', () => {
    for (const page of [catalogPage, marketPage]) {
      expect(page).toContain('getTourForCard');
      expect(page).toContain('getTourReviews');
      // своего SELECT в странице быть не должно — иначе копии снова разъедутся
      expect(page).not.toMatch(/FROM operator_tours/);
    }
  });

  it('отставшая миграция не даёт 404 на живом туре', () => {
    // 42703 = undefined_column: повторяем запрос без колонок 809
    expect(query).toContain('42703');
    expect(query).toContain('buildSql(false)');
  });
});

describe('стандарт карточки тура — честность данных', () => {
  it('даты берутся существующим слот-механизмом, а не выдуманным полем', () => {
    expect(src).not.toContain('available_dates');
  });

  it('не печатает заголовок краевого алерта как предупреждение о туре', () => {
    // На карточке сплава по Быстрой всплывало «риск схода оползней с вулкана
    // Мутновского»: /api/public/safety-status отдаёт максимальный алерт по краю
    // без привязки к географии тура. Чужое предупреждение размывает доверие к
    // настоящему — релевантные даёт SafetyWarnings по tourId.
    expect(src).not.toMatch(/\{dayStatus\.title\}/);
    expect(src).not.toMatch(/dayStatus\?\.title\s*&&/);
    // Индикатор остаётся, но подписан как краевой, а не как оценка поездки.
    expect(src).toContain('Обстановка в крае');
    expect(src).toContain('SafetyWarnings');
  });

  it('в герое каждый факт напечатан ровно один раз', () => {
    // Было: сезон в пилюле справа вверху И в полосе фактов; размер группы в
    // строке под заголовком И там же в полосе. Один факт дважды на одном
    // экране — не акцент, а небрежность, и владелец это увидел сразу.
    const heroSeasonPills = [...src.matchAll(/>Сезон</g)].length;
    expect(heroSeasonPills, 'сезон снова печатается дважды').toBeLessThanOrEqual(1);
    expect(src).not.toMatch(/до \{tour\.max_participants\} чел\./);
  });

  it('метка и значение не заикаются', () => {
    // «СЛОЖНОСТЬ · Средняя сложность» — под меткой нужна короткая форма,
    // она для того в словаре и заведена.
    expect(src).toMatch(/difficultyLabel\(tour\.difficulty, true\)/);
    expect(src).not.toMatch(/k: 'Сложность', v: diffBadge\.label/);
  });

  it('нет партнёрских блоков агрегаторов', () => {
    // Решение владельца 04.08. Они печатали рекламный дисклеймер с ИНН чужих
    // юрлиц под карточкой тура нашего проверенного оператора — турист видел
    // подмену продавца. Карточка тура продаёт тур оператора, а не чужие сервисы.
    expect(src).not.toContain('RouteAffiliateBlock');
    expect(src).not.toContain('YandexTravelBlock');
  });

  it('контакты оператора — из partners.contacts, а не из выдуманного поля тура', () => {
    expect(src).toContain('operator_contacts');
    expect(src).not.toContain('contact_phones');
    expect(query).toContain('p.contacts AS operator_contacts');
  });

  it('программа разбирается защитно (JSONB форму никто не гарантирует)', () => {
    expect(src).toContain('function toProgram');
    expect(src).toMatch(/Array\.isArray\(v\)/);
  });

  it('статус дня fail-soft: нет данных — блока нет', () => {
    expect(src).toContain('/api/public/safety-status');
    expect(src).toMatch(/catch\(\(\)\s*=>\s*\{/);
    expect(src).toContain('dayStatus &&');
  });
});

describe('стандарт карточки тура — дизайн-система', () => {
  it('дисплейный шрифт — Playfair (голос платформы), не Unbounded', () => {
    expect(src).toContain("const FD = 'var(--font-playfair)'");
    expect(src).not.toContain('--font-unbounded');
  });

  it('без эмодзи', () => {
    expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('без хардкода hex в цветах текста и фона (кроме скримов поверх фото)', () => {
    // допускаем rgba-скримы градиента поверх фото; ловим именно hex-заливки
    const hexes = src.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    // единственный допустимый — тёмный якорь градиента внутри color-mix
    const allowed = new Set(['#06131a']);
    for (const h of hexes) expect(allowed.has(h)).toBe(true);
  });

  it('без @keyframes — только transition-утилиты', () => {
    expect(src).not.toContain('@keyframes');
    expect(src).toMatch(/transition-(all|colors|transform)/);
  });

  it('интерактив не мельче 44px', () => {
    expect(src).toMatch(/minHeight:\s*44/);
  });

  it('стекло — только поверх фото (в hero), на сплошных фонах ds-card', () => {
    expect(src).toContain('backdrop-blur-md');
    expect(src).toContain('ds-card');
  });
});
