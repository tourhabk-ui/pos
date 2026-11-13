/**
 * Живая проба машинного перевода — замер с прода (13.11).
 *
 * Перевод переписки заявки ждут не дольше срока переписки
 * (`CHAT_TRANSLATE_TIMEOUT_MS`), а ответ модели сверяется: не уложилась или
 * не прошла сверку — человек читает «машинный перевод не получен». Тесты
 * судят правило на подставной модели и не говорят главного: успевает ли
 * настоящая модель с прода и принимает ли сверка то, что она пишет на деле.
 * Проба отвечает замером: зовёт то же правило (`lib/ai/translate-text`) на
 * постоянных текстах и возвращает исход, причину отказа, сам перевод и время.
 *
 * Тексты придуманы для пробы: в них нет ни имён, ни телефонов, ни слов
 * настоящих клиентов и партнёров. Посылать ради замера настоящее сообщение
 * нельзя — и не нужно.
 *
 * Один вызов — один случай: проверка прода ждёт ответ не дольше минуты.
 * Случай, не уложившийся в `PROBE_CASE_TIMEOUT_MS`, — «не смог», а не
 * «плохой перевод» (§4.0).
 */
import { translateFromRussian, translateToRussian, type ForeignTranslationOutcome, type TranslationOutcome } from '@/lib/ai/translate-text';
import { CHAT_TRANSLATE_TIMEOUT_MS } from '@/lib/requests/chat-translation';

export interface TranslationProbeCase {
  name: string;
  direction: 'to_russian' | 'from_russian';
  text: string;
  /** Образец языка клиента — для перевода с русского. */
  sample?: string;
}

const SAMPLE_EN = 'Can we start at 9 am tomorrow?';
const SAMPLE_ZH = '我们明天早上9点可以出发吗？';

const RU_SHORT = 'Да, начнём в 9:00. Сбор у гостиницы, возвращение около 19:00. Возьмите тёплую куртку.';

const RU_LONG = [
  'Здравствуйте! Тур идёт один день. Сбор в 8:00 у вашей гостиницы в Петропавловске-Камчатском, возвращение около 19:00.',
  'Едем на вездеходе до подножия вулкана, дорога занимает около 3 часов в одну сторону.',
  'Подъём пешком — 4 км, набор высоты 600 м, идём 2–3 часа в спокойном темпе.',
  'На плато обедаем: горячий суп, чай, бутерброды — всё входит в цену.',
  'С собой возьмите треккинговые ботинки, ветровку, тёплую кофту, перчатки, солнцезащитные очки и 1 литр воды. Палки и каски выдаём.',
  'Группа до 8 человек, с вами едут гид и водитель.',
  'Если погода закроет перевал, перенесём выезд на следующий день или вернём деньги полностью.',
  'Цена — 15 000 рублей с человека, оплата на месте в день тура.',
  'Напишите, пожалуйста, сколько вас будет и нет ли у кого-то ограничений по здоровью.',
].join(' ');

export const TRANSLATION_PROBE_CASES: readonly TranslationProbeCase[] = [
  { name: 'en_short', direction: 'to_russian', text: 'Hello! Can we start at 9 am tomorrow? There are 2 of us, and we would like to be back by 7 pm.' },
  { name: 'zh_short', direction: 'to_russian', text: '你好！我们明天早上9点可以出发吗？我们一共2个人，希望晚上7点前回来。' },
  {
    name: 'zh_long', direction: 'to_russian',
    text: '你好，我们是一家三口，计划7月15日到7月20日在堪察加旅行。想参加穆特诺夫斯基火山一日游，孩子12岁，可以参加吗？费用是多少？需要自己带登山鞋和雨衣吗？酒店在彼得罗巴甫洛夫斯克市中心，可以到酒店接我们吗？谢谢！',
  },
  { name: 'ru_short_to_en', direction: 'from_russian', text: RU_SHORT, sample: SAMPLE_EN },
  { name: 'ru_short_to_zh', direction: 'from_russian', text: RU_SHORT, sample: SAMPLE_ZH },
  { name: 'ru_long_to_en', direction: 'from_russian', text: RU_LONG, sample: SAMPLE_EN },
  { name: 'ru_long_to_zh', direction: 'from_russian', text: RU_LONG, sample: SAMPLE_ZH },
];

/** Сколько ждём один случай: меньше минуты, которую ждёт проверка прода. */
export const PROBE_CASE_TIMEOUT_MS = 45_000;

export interface TranslationProbeRow {
  name: string;
  direction: 'to_russian' | 'from_russian';
  /** Длина исходника в знаках. */
  chars: number;
  ms: number;
  status: 'translated' | 'not_needed' | 'failed' | 'timeout';
  /** Причина отказа словами правила; у прочих исходов — null. */
  reason: string | null;
  /** Перевод, который вернуло правило; не «translated» — null. */
  text: string | null;
  /** Уложился ли случай в срок, который ждёт переписка заявки. */
  within_chat_limit: boolean;
  chat_limit_ms: number;
}

export interface TranslationProbeDeps {
  toRussian?: (text: string) => Promise<TranslationOutcome>;
  fromRussian?: (text: string, sample: string) => Promise<ForeignTranslationOutcome>;
  now?: () => number;
  timeoutMs?: number;
}

export function probeCase(name: string | null | undefined): TranslationProbeCase | null {
  return TRANSLATION_PROBE_CASES.find((c) => c.name === name) ?? null;
}

type Raced = TranslationOutcome | ForeignTranslationOutcome | { status: 'timeout' } | { status: 'threw'; message: string };

/** Прогнать один случай. Не бросает: упавшее правило — исход «failed» с причиной. */
export async function runTranslationProbe(c: TranslationProbeCase, deps: TranslationProbeDeps = {}): Promise<TranslationProbeRow> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? PROBE_CASE_TIMEOUT_MS;
  const toRussian = deps.toRussian ?? ((t: string) => translateToRussian(t));
  const fromRussian = deps.fromRussian ?? ((t: string, s: string) => translateFromRussian(t, s));

  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Raced>((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs); });
  const call: Promise<Raced> = (c.direction === 'to_russian' ? toRussian(c.text) : fromRussian(c.text, c.sample ?? ''))
    .catch((err: unknown): Raced => ({ status: 'threw', message: err instanceof Error ? err.message : String(err) }));
  let out: Raced;
  try {
    out = await Promise.race([call, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const ms = now() - started;

  const base = { name: c.name, direction: c.direction, chars: c.text.length, ms, chat_limit_ms: CHAT_TRANSLATE_TIMEOUT_MS };
  if (out.status === 'translated') {
    return { ...base, status: 'translated', reason: null, text: out.text, within_chat_limit: ms <= CHAT_TRANSLATE_TIMEOUT_MS };
  }
  // Перевода нет — в срок переписки он не уложился по определению: человек его не получил бы.
  if (out.status === 'timeout') {
    return { ...base, status: 'timeout', reason: `случай не уложился в ${Math.round(timeoutMs / 1000)} с — исход неизвестен`, text: null, within_chat_limit: false };
  }
  if (out.status === 'threw') {
    return { ...base, status: 'failed', reason: `правило перевода упало: ${out.message}`.slice(0, 300), text: null, within_chat_limit: false };
  }
  if (out.status === 'failed') {
    return { ...base, status: 'failed', reason: out.reason, text: null, within_chat_limit: false };
  }
  // Постоянные тексты пробы перевода требуют: «не нужен» здесь — дефект правила, и он назван.
  return { ...base, status: 'not_needed', reason: 'правило сочло, что перевод не нужен, — у текста пробы это ошибка', text: null, within_chat_limit: false };
}
