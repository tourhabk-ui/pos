/**
 * Вопросы и ответы о месте (слово владельца 17.11 «2 да но аккуратно»).
 *
 * Блок нужен для ИИ-поиска: он цитирует страницу, которая отвечает на вопрос
 * прямо, одним абзацем. Правила те же, что у тура (`lib/tours/tour-faq`):
 *
 *  1. **Ответ — словами карточки.** Каждый ответ собирает та же функция или
 *     тот же словарь, что рисует раздел карточки места: «Как добраться» —
 *     `composeAccessText`, опасности — `hazardPhrase`, сложность —
 *     `DIFFICULTY_LABELS`, номер — `lib/safety/emergency-numbers`. Своих
 *     формулировок у блока нет.
 *  2. **Без ответа нет и вопроса.** Не записано — вопроса нет. «Опасности не
 *     записаны» на карточке сказано словами (§4.0), а в блоке вопросов такой
 *     ответ стал бы цитатой «у места X опасностей не знаем» без карточки
 *     рядом — его нет.
 *  3. **Блок не смелее карточки и чужой цитаты.** Чужой поиск процитирует
 *     ответ без соседних строк, поэтому:
 *       - «где находится» не произносится по угаданной или заглушечной
 *         координате (`coordSource` `geocoded` / `placeholder`): карточка
 *         рядом с ней предупреждает, цитата — нет;
 *       - туров в ответах нет (§9: точка — не коммерция);
 *       - обстановки дня нет: она меняется каждый день, а цитата живёт
 *         неделями;
 *       - регистрация в МЧС и спутниковая связь называются, только когда
 *         записано «нужна»: «не записано» не значит «не нужна».
 *
 * Профиль безопасности сюда приходит уже очищенным от шаблона 070
 * (`honestSafetyFields` в `lib/places/place-detail`): шаблонные опасности и
 * сложность не доходят до карточки и не доходят сюда.
 *
 * Разметка FAQPage строится из того же массива, что и видимый блок
 * (`components/faq/FaqSection`).
 *
 * Сторож: tests/unit/place-faq.test.tsx.
 */

import type { FaqItem } from '@/lib/seo/faq';
import { composeAccessText, type AccessRoute } from '@/lib/places/access-text';
import type { CoordSource } from '@/lib/places/coord-source';
import { hazardPhrase } from '@/lib/safety/hazard-labels';
import { MCHS_DEADLINE_SHORT, MCHS_REQUIRED_PHRASE } from '@/lib/safety/mchs-registration';
import { EMERGENCY_PRIMARY, verifiedRegionalNumber } from '@/lib/safety/emergency-numbers';
import { DIFFICULTY_LABELS } from '@/components/places/types';

export interface PlaceFaqInput {
  name: string;
  lat: number;
  lng: number;
  coordSource?: CoordSource;
  district: string | null;
  zone: string | null;
  accessInfo: string | null;
  bestSeason: string | null;
  routes: AccessRoute[];
  eco: { zone: string | null; permitRequired: boolean | null } | null;
  safety: {
    difficultyLevel: number | null;
    altitudeM: number | null;
    nearestMedicalKm: number | null;
    satCommunicatorRequired: boolean | null;
    registrationRequired: boolean;
    hazardTypes: string[];
    phoneRangerMches: string | null;
  };
}

/** Координата, по которой «где находится» не произносится. */
const UNSAYABLE_COORDS: ReadonlySet<CoordSource> = new Set(['geocoded', 'placeholder']);

const withDot = (s: string): string => {
  const t = s.trim().replace(/\s+/g, ' ');
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

export function placeFaq(p: PlaceFaqInput): FaqItem[] {
  const name = `«${p.name}»`;
  const items: FaqItem[] = [];

  // Как добраться — те же предложения, что раздел карточки. Без предложения о
  // турах (§9) и без «где» по угаданной координате.
  const access = composeAccessText({
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    district: p.district,
    zone: p.zone,
    accessInfo: p.accessInfo,
    routes: p.routes,
    registrationRequired: p.safety.registrationRequired,
    eco: p.eco,
    toursCount: 0,
  });
  const accessSentences = p.coordSource && UNSAYABLE_COORDS.has(p.coordSource) ? access.slice(1) : access;
  if (accessSentences.length > 0) {
    items.push({ question: `Как добраться до места ${name}?`, answer: accessSentences.join(' ') });
  }

  if (p.bestSeason?.trim()) {
    items.push({ question: `Когда лучше посещать место ${name}?`, answer: withDot(p.bestSeason) });
  }

  const d = p.safety.difficultyLevel;
  if (d != null && DIFFICULTY_LABELS[d]) {
    items.push({
      question: `Насколько сложно посещение места ${name}?`,
      answer: `Сложность: «${DIFFICULTY_LABELS[d]}» (${d} из ${DIFFICULTY_LABELS.length - 1}).`,
    });
  }

  if (p.safety.altitudeM != null) {
    items.push({
      question: `Какая высота у места ${name}?`,
      answer: `Высота — ${p.safety.altitudeM.toLocaleString('ru-RU')} м.`,
    });
  }

  // Опасности — фразами словаря. Ключ без фразы на карточке виден как есть
  // (`hazardLabel`), а в цитате сырое английское слово читалось бы как текст;
  // выбросить его — значит назвать неполный список полным. Поэтому при
  // незнакомом ключе вопроса нет вовсе: на карточке опасности по-прежнему видны.
  const hazardPhrases = p.safety.hazardTypes.map((h) => hazardPhrase(h));
  if (hazardPhrases.length > 0 && hazardPhrases.every((x): x is string => Boolean(x))) {
    items.push({
      question: `Какие опасности у места ${name}?`,
      answer: hazardPhrases.map((x) => withDot(x as string)).join(' '),
    });
  }

  if (p.safety.registrationRequired) {
    items.push({
      question: `Нужна ли регистрация в МЧС для посещения места ${name}?`,
      answer: `Да. ${MCHS_REQUIRED_PHRASE} ${withDot(MCHS_DEADLINE_SHORT)}`,
    });
  }

  if (p.safety.satCommunicatorRequired) {
    items.push({
      question: `Нужен ли спутниковый мессенджер у места ${name}?`,
      answer: 'Да, нужен спутниковый мессенджер.',
    });
  }

  if (p.safety.nearestMedicalKm != null) {
    items.push({
      question: `Далеко ли от места ${name} до медицинской помощи?`,
      answer: `До медпомощи — ${p.safety.nearestMedicalKm} км.`,
    });
  }

  // Номер — всегда: кнопка 112 есть на каждой карточке места. Региональный —
  // только проверенный владельцем, тем же правилом, что кнопка.
  const regional = verifiedRegionalNumber(p.safety.phoneRangerMches);
  items.push({
    question: `Куда звонить в экстренной ситуации у места ${name}?`,
    answer: [
      `${EMERGENCY_PRIMARY.phone} — ${EMERGENCY_PRIMARY.name.toLowerCase().replace(/ · /g, ', ')}.`,
      EMERGENCY_PRIMARY.hint ? withDot(EMERGENCY_PRIMARY.hint) : null,
      regional ? `${regional.phone} — ${regional.name}.` : null,
    ].filter(Boolean).join(' '),
  });

  return items;
}
