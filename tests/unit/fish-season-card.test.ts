/**
 * «Когда какая рыба клюёт?» — сезонная сетка на карточке тура.
 *
 * Владелец 06.08: «у них крутая рыбалка и рыбы много разной — нужно сделать
 * карточки интереснее и по сезонам… в наших карточках есть уже рыба по сезону».
 * Прав: справочник lib/fish-species.ts с seasonMonths уже был (кормит /fish и
 * ссылки в описаниях) — блок обязан строиться ИЗ НЕГО, а не заводить второй
 * список видов. Расхождение копий — ровно то, за что платили карточкой тура.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectFishSpecies, FISH_SPECIES, MONTH_SHORT } from '@/lib/fish-species';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('detectFishSpecies: связка тур → рыба', () => {
  it('находит виды по падежам в живом тексте тура', () => {
    const ids = detectFishSpecies(
      'Ловим чавычу и кижуча, вечером уха из хариуса',
    ).map(s => s.id);
    expect(ids).toContain('chavycha');
    expect(ids).toContain('kizuch');
    expect(ids).toContain('kharius');
  });

  it('зонтичный «лосось» отбрасывается при конкретных видах', () => {
    const ids = detectFishSpecies('Лосось: ловим чавычу на спиннинг').map(s => s.id);
    expect(ids).toContain('chavycha');
    expect(ids).not.toContain('losos');
  });

  it('только зонтичное упоминание — остаётся зонтик', () => {
    expect(detectFishSpecies('Рыбалка на лосося').map(s => s.id)).toEqual(['losos']);
  });

  it('нет рыбы — пустой список (блок не рендерится)', () => {
    expect(detectFishSpecies('Восхождение на Авачинский вулкан')).toEqual([]);
  });

  it('детект не статфулен: два вызова подряд дают одинаковый результат', () => {
    // Паттерны справочника с флагом g — у test() был бы блуждающий lastIndex.
    const text = 'чавыча чавыча';
    expect(detectFishSpecies(text).length).toBe(detectFishSpecies(text).length);
  });
});

describe('справочник пригоден для сетки', () => {
  it('у каждого вида непустые seasonMonths в диапазоне 1-12', () => {
    for (const sp of FISH_SPECIES) {
      expect(sp.seasonMonths.length, sp.id).toBeGreaterThan(0);
      for (const m of sp.seasonMonths) {
        expect(m, sp.id).toBeGreaterThanOrEqual(1);
        expect(m, sp.id).toBeLessThanOrEqual(12);
      }
    }
  });

  it('месяцев ровно 12', () => {
    expect(MONTH_SHORT).toHaveLength(12);
  });
});

describe('карточка тура', () => {
  it('блок подключён в единственную карточку тура и fail-soft', () => {
    const src = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
    expect(src).toMatch(/FishSeasonCalendar/);
    expect(src).toMatch(/detectFishSpecies/);
    expect(src).toMatch(/fishSpecies\.length > 0 &&/);
    expect(src).toMatch(/Когда какая рыба клюёт\?/);
  });

  it('компонент строится из единого справочника, своего списка видов нет', () => {
    const src = read('components/tours/FishSeasonCalendar.tsx');
    expect(src).toMatch(/from '@\/lib\/fish-species'/);
    // Ни одного своего вида: латинских названий и seasonMonths-литералов нет.
    expect(src).not.toMatch(/Oncorhynchus|seasonMonths:\s*\[/);
    // Сводка текстом — цитируемость (GEO) и доступность, не только заливка.
    expect(src).toMatch(/sp\.season\.toLowerCase\(\)/);
  });

  it('стандарт §11 знает о блоке', () => {
    expect(read('CLAUDE.md')).toMatch(/Когда какая\s+рыба клюёт\?/);
  });
});

describe('страница вида /fish/[id]: упомянутые виды кликабельны', () => {
  // Владелец 07.08: «раздел лосось — там перечисление рыб, а у нас есть
  // описания по видам, нужно открытие страниц описаний». Описание «лосося»
  // называет чавычу-нерку-кижуча-горбушу-кету — каждое имя стало ссылкой.
  it('описание и факт идут через DescriptionWithFishLinks с исключением себя', () => {
    const src = read('app/fish/[id]/page.tsx');
    const uses = src.match(/<DescriptionWithFishLinks/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/excludeId=\{species\.id\}/);
  });

  it('parseTextChunks: excludeId убирает самоссылку, остальные виды остаются', async () => {
    const { parseTextChunks } = await import('@/components/shared/DescriptionWithFishLinks');
    const text = 'Лосось: чавыча и кижуч заходят в реки';
    const withSelf = parseTextChunks(text).filter(c => c.species).map(c => c.species!.id);
    expect(withSelf).toContain('losos');
    const withoutSelf = parseTextChunks(text, 'losos').filter(c => c.species).map(c => c.species!.id);
    expect(withoutSelf).not.toContain('losos');
    expect(withoutSelf).toContain('chavycha');
    expect(withoutSelf).toContain('kizuch');
  });
});
