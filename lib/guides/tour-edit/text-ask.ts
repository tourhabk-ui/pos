/**
 * «Дай текст тура» — гид получает текст своего тура из базы сообщением
 * (05.11, слово владельца «да делай»).
 *
 * Гид Андрей Запорожец попросил в MAX «дай мне текст тура ID71 в формате
 * word». Фраза уходила в модель, и та сочинила описание и программу тура, у
 * которого в базе их нет. Теперь просьба разбирается без модели, а ответ —
 * поля тура как записаны, в форме фразы правки: строку можно скопировать,
 * поправить и прислать обратно, придёт «было → станет» и кнопка «Сохранить».
 * Файла (.docx) платформа не делает — это сказано в ответе.
 */
import { escapeHtml } from '@/lib/text/escape-html';
import { FIELD_LABEL, type EditField } from './parse';
import type { ChatTour } from './store';
import type { TourProgramStep } from '@/lib/tours/tour-write';

export interface TextAsk {
  /** Слова тура после «текст тура»; null — тур не назван. */
  tourWords: string | null;
  /** «ID71» / «71» — номер тура; null — не номер. */
  tourId: string | null;
}

const ASK = /^(?:(?:дай(?:те)?|покажи(?:те)?|пришли(?:те)?|скинь(?:те)?|отправь(?:те)?|выгрузи(?:те)?|выдай(?:те)?)\s+)?(?:мне\s+)?(?:весь\s+|полный\s+|целиком\s+)?текст\s+(?:своего\s+|моего\s+)?тура(?=$|[\s:,.«"])(.*)$/is;
const FORMAT = /\s*(?:в\s+формате\s+\S+|в\s+(?:ворде|word|docx)|документом(?:\s+word)?|файлом|\.?docx)\s*/gi;

/** Просьба прислать текст тура или нет. */
export function parseTourTextAsk(raw: string): TextAsk | null {
  const m = ASK.exec(raw.replace(/\r\n?/g, '\n').trim());
  if (!m) return null;
  const rest = m[1]!.replace(FORMAT, ' ').replace(/^[\s:,.—-]+|[\s.?!]+$/g, '').replace(/^[«"„]+|[»"“]+$/g, '').trim();
  if (!rest) return { tourWords: null, tourId: null };
  const id = /^(?:id|ид|№)?\s*(\d{1,9})$/i.exec(rest);
  return id ? { tourWords: null, tourId: id[1]! } : { tourWords: rest, tourId: null };
}

/** Порядок полей в ответе и слово поля во фразе правки. */
const FIELDS: ReadonlyArray<[EditField, string]> = [
  ['short_description', 'анонс'],
  ['description', 'описание'],
  ['program', 'программа'],
  ['included', 'что включено'],
  ['not_included', 'не входит'],
  ['what_to_bring', 'что взять'],
  ['safety_notes', 'безопасность'],
];

/** Сколько знаков текста влезает в одно сообщение с запасом (MAX — 4000). */
export const TEXT_BUDGET = 3300;

function valueText(field: EditField, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (field === 'program') {
    const steps = v as TourProgramStep[];
    return steps.length ? '\n' + steps.map((s, i) => `${i + 1}. ${s.title}${s.text ? `: ${s.text}` : ''}`).join('\n') : null;
  }
  if (Array.isArray(v)) return v.length ? (field === 'safety_notes' ? '\n' + v.join('\n') : v.join('; ')) : null;
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Строки ответа. Поле целиком — строкой фразы правки; длиннее остатка
 * сообщения — первые слова и «целиком на сайте»: обрезанное нельзя слать
 * обратно, правка записала бы обрубок.
 */
export function tourTextLines(t: ChatTour, name: string, siteOwnUrl: string): string[] {
  const lines = [
    `<b>Текст тура «${escapeHtml(t.title)}»</b> — как записан на Ведаре.`,
    'Поправить поле: скопируйте его строку, измените текст и пришлите мне — покажу «было → станет», запишется кнопкой «Сохранить».',
  ];
  let left = TEXT_BUDGET;
  const empty: string[] = [];
  for (const [field, word] of FIELDS) {
    const text = valueText(field, t.fields[field]);
    if (text === null) { empty.push(FIELD_LABEL[field].toLowerCase()); continue; }
    const phrase = `${name}: ${word}: ${text}`;
    if (phrase.length <= left) {
      lines.push('', `<code>${escapeHtml(phrase)}</code>`);
      left -= phrase.length;
    } else {
      const head = text.trim().slice(0, 200).replace(/\s+\S*$/, '');
      lines.push('', `${FIELD_LABEL[field]} — ${text.length} знаков, целиком в сообщение не помещается. Начало: «${escapeHtml(head)}…». `
        + `Целиком — на сайте: ${escapeHtml(siteOwnUrl)}, «Править» у тура.`);
      left -= 260;
    }
  }
  if (empty.length) lines.push('', `Не записано: ${empty.join(', ')}.`);
  lines.push('', 'Файлом Word текст не выгружается. Свой документ Word можно прислать сюда — разложу по полям с кнопкой.');
  return lines;
}
