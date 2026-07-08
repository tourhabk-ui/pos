/**
 * lib/parks/permit-matrix.ts
 *
 * Матрица «вершина → парк-согласователь» из issue #367 (источник —
 * раздел безопасности visitkamchatka.ru, июль 2026):
 *   Налычево: Ааг, Арик, Корякский, Авачинский
 *   Ключевской парк: Ключевская, Толбачик, Камень
 *   Вачкажец: памятник природы с отдельным разрешением
 *
 * Маппинг КОНСЕРВАТИВНЫЙ: границы слов через lookaround (\b с кириллицей
 * не работает), исключения для ложных совпадений (Авачинская бухта — не
 * Налычево), «Камень» — только в ambiguous (слишком общее слово, отчёт
 * на ручную разметку, автопривязки нет).
 */

export interface VertexRule {
  vertex: string;
  pattern: RegExp;
  exclude?: RegExp;
}

export interface ParkVertexRules {
  parkSlug: string;
  /** Значение для kamchatka_routes.park_name — содержит search_term парка */
  parkName: string;
  vertices: VertexRule[];
}

export const PARK_VERTEX_MATRIX: ParkVertexRules[] = [
  {
    parkSlug: 'nalychevo',
    parkName: 'Налычево',
    vertices: [
      { vertex: 'Ааг', pattern: /(?<![а-яёa-z])ааг(?![а-яё])/i },
      { vertex: 'Арик', pattern: /(?<![а-яёa-z])арик(?![а-яё])/i },
      { vertex: 'Корякский', pattern: /(?<![а-яёa-z])корякск/i },
      // Авачинская бухта/залив — не территория Налычево
      { vertex: 'Авачинский', pattern: /(?<![а-яёa-z])авачинск/i, exclude: /бухт|залив/i },
    ],
  },
  {
    parkSlug: 'klyuchevskoy',
    parkName: 'Ключевской',
    vertices: [
      { vertex: 'Ключевская', pattern: /(?<![а-яёa-z])ключевск/i },
      { vertex: 'Толбачик', pattern: /(?<![а-яёa-z])толбачик/i },
    ],
  },
  {
    parkSlug: 'vachkazhets',
    parkName: 'Вачкажец',
    vertices: [
      { vertex: 'Вачкажец', pattern: /(?<![а-яёa-z])вачкажец/i },
    ],
  },
];

/**
 * «Камень» — вулкан Ключевской группы, но слово слишком общее
 * (Белый Камень, каменные поленницы...). Только ручная разметка —
 * регистр учитывается, чтобы не ловить нарицательное «камень».
 */
export const AMBIGUOUS_VERTEX_RULES: (VertexRule & { parkSlug: string; parkName: string })[] = [
  {
    parkSlug: 'klyuchevskoy',
    parkName: 'Ключевской',
    vertex: 'Камень',
    pattern: /(?<![а-яёА-ЯЁa-z])Камень(?![а-яё])/,
  },
];

export interface VertexMatch {
  parkSlug: string;
  parkName: string;
  vertex: string;
  confidence: 'matched' | 'ambiguous';
}

/**
 * Сопоставление названия маршрута с парком-согласователем.
 * Уверенное совпадение → matched; только «Камень» → ambiguous
 * (в отчёт, БЕЗ автопривязки); ничего → null.
 */
export function matchTitleToPark(title: string): VertexMatch | null {
  for (const park of PARK_VERTEX_MATRIX) {
    for (const rule of park.vertices) {
      if (rule.pattern.test(title) && !(rule.exclude && rule.exclude.test(title))) {
        return {
          parkSlug: park.parkSlug,
          parkName: park.parkName,
          vertex: rule.vertex,
          confidence: 'matched',
        };
      }
    }
  }

  for (const rule of AMBIGUOUS_VERTEX_RULES) {
    if (rule.pattern.test(title)) {
      return {
        parkSlug: rule.parkSlug,
        parkName: rule.parkName,
        vertex: rule.vertex,
        confidence: 'ambiguous',
      };
    }
  }

  return null;
}
