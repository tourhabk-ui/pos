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

  it('обе страницы тура отдают safety_notes и program', () => {
    for (const page of [catalogPage, marketPage]) {
      expect(page).toContain('ot.program');
      expect(page).toContain('ot.safety_notes');
    }
  });
});

describe('стандарт карточки тура — честность данных', () => {
  it('даты берутся существующим слот-механизмом, а не выдуманным полем', () => {
    expect(src).not.toContain('available_dates');
  });

  it('контакты оператора — из partners.contacts, а не из выдуманного поля тура', () => {
    expect(src).toContain('operator_contacts');
    expect(src).not.toContain('contact_phones');
    for (const page of [catalogPage, marketPage]) {
      expect(page).toContain('p.contacts AS operator_contacts');
    }
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
