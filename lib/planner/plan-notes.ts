/**
 * Вид плана /planner и его PDF (слово владельца 22.11: «предупреждения — кроме
 * них ничего не видно», «ученик 1 класса»).
 *
 * Над днями больше нет стопки жёлтых плашек. Предупреждения движка о форме
 * плана делятся на два честных места:
 *  - «Этого в плане нет» — что из просьбы не вошло и почему (зона не влезла
 *    по дням, туров под занятие нет). Спокойный список сразу под сводкой;
 *  - «О плане» — остальные оговорки (сезон по записи оператора, тур продают
 *    целиком) — внутри одного свёрнутого блока вместе с «Безопасностью и
 *    разрешениями».
 * Плюс интересы из анкеты, под которые в плане нет ни одного дня, а движок
 * этого не сказал, — тоже в «Этого в плане нет», без выдуманной причины.
 */
import { planShapeWarnings, type PlanWarningLike } from '@/lib/planner/day-card-view';

/** Строка о том, что из просьбы в план не вошло (по тексту движка). */
const NOT_IN_PLAN_RE = /не вошл|в план не|нет в плане|не поместил|не уместил/i;

export function splitPlanShape<W extends PlanWarningLike>(warnings: readonly W[]): { notInPlan: W[]; aboutPlan: W[] } {
  // Критичное («план не собрался») стоит над днями отдельно — здесь его нет.
  const shape = planShapeWarnings(warnings).filter((w) => w.severity !== 'critical');
  return {
    notInPlan: shape.filter((w) => NOT_IN_PLAN_RE.test(w.message)),
    aboutPlan: shape.filter((w) => !NOT_IN_PLAN_RE.test(w.message)),
  };
}

/** По каким словам в названии дня видно занятие анкеты. */
const INTEREST_STEMS: Readonly<Record<string, readonly string[]>> = {
  volcano: ['вулкан'],
  hot_spring: ['термал', 'источник'],
  geyser: ['гейзер'],
  sea: ['побереж', 'океан', 'бухт', 'мыс '],
  mountain: ['хреб', 'гор'],
  river: ['река', 'реки', 'сплав'],
  trekking: ['трек', 'поход', 'восхожд'],
  fishing: ['рыбал'],
  helicopter: ['вертол', 'облёт', 'облет'],
  bears: ['медвед'],
  snowmobile: ['снегоход'],
  boat_trip: ['морск', 'катер', 'бухт'],
};

/** Как занятие называет текст движка («Рыбалка, снегоходы — …»). */
const INTEREST_WORD: Readonly<Record<string, string>> = {
  volcano: 'вулкан', hot_spring: 'термал', geyser: 'гейзер', sea: 'побереж', mountain: 'хреб', river: 'рек',
  trekking: 'трек', fishing: 'рыбал', helicopter: 'вертол', bears: 'медвед', snowmobile: 'снегоход', boat_trip: 'морск',
};

interface PlanDayLike { type?: string; title: string; activityType?: string; realTour?: unknown }

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/**
 * Интересы анкеты, под которые нет ни одного дня занятия и о которых движок
 * ничего не сказал. Причину не придумываем — только факт.
 */
export function interestsWithoutDay(
  interests: readonly string[],
  days: readonly PlanDayLike[],
  said: readonly string[],
  label: (id: string) => string,
): string[] {
  const active = days.filter((d) => (d.type ?? 'activity') === 'activity');
  if (active.length === 0) return [];
  const saidText = norm(said.join(' '));
  const out: string[] = [];
  for (const id of interests) {
    const stems = INTEREST_STEMS[id];
    if (!stems) continue;
    const covered = active.some((d) => d.activityType === id || stems.some((s) => norm(d.title).includes(norm(s))));
    if (covered) continue;
    const word = INTEREST_WORD[id];
    if (word && saidText.includes(norm(word))) continue;
    out.push(`${label(id)} — в плане нет дня с этим. Хотите — добавьте день или напишите оператору в заявке.`);
  }
  return out;
}

/** Всё для блока «Этого в плане нет»: строки движка и интересы без дня. */
export function notInPlanLines(
  warnings: readonly PlanWarningLike[],
  interests: readonly string[],
  days: readonly PlanDayLike[],
  label: (id: string) => string,
): string[] {
  const engine = splitPlanShape(warnings).notInPlan.map((w) => w.message);
  return [...engine, ...interestsWithoutDay(interests, days, engine, label)];
}

/** «вт, 24 ноя» по дате YYYY-MM-DD; плохая дата — пусто. */
export function dayDateShort(iso: string | null | undefined): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return '';
  const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getUTCDay()];
  const mon = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][d.getUTCMonth()];
  return `${wd}, ${d.getUTCDate()} ${mon}`;
}

/**
 * Честное ожидание сборки: что делается и сколько уже идёт. Без обещаний
 * «за секунды» — после 15 с говорим, что дольше обычного.
 */
export function buildWaitLine(seconds: number): string {
  if (seconds < 15) return `Подбираем туры из каталога, проверяем места и прогноз на ваши даты… ${seconds} с`;
  return `Дольше обычного (${seconds} с): проверяем места у операторов и прогноз. Можно подождать — план появится здесь.`;
}
