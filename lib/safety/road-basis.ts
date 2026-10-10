/**
 * Основание пункта ленты безопасности — документ, по которому закрыли дорогу
 * (приказ, распоряжение). Решение владельца 10.10: «чтоб искал основание для
 * таких сообщений».
 *
 * Откуда берётся:
 *  - вписывает администратор (basis_origin = 'manual') — проверено человеком;
 *  - читается со снимка поста (basis_origin = 'image_ocr'): канал «Право на
 *    Руль» публикует приказы Камчатуправтодора фотографией бумаги, а текст
 *    поста говорит только «сообщили в управлении автодорог». Снимок читает
 *    зрение (callVisionDetailed — с прода достижим Qwen-VL), и экран говорит
 *    прямо: «распознано со снимка», рядом ссылка на снимок. Номер на фото
 *    листа модель может прочесть неточно — проверить его можно только глазами.
 *
 * Срок. Распознанный срок действия приказа срок пункта только ПРОДЛЕВАЕТ
 * (GREATEST): лучше лишний час показывать «закрыто», чем отправить людей на
 * закрытую косу из-за неверно прочитанной цифры.
 *
 * Отказ зрения — «не смогли проверить» (§4.0): отметка unavailable и повтор
 * через час, а не «документа нет».
 */
import { z } from 'zod';
import { callVisionDetailed } from '@/lib/ai/providers';
import type { BasisReading } from '@/lib/safety/road-basis-queue';

export type { BasisReading };

const VISION_PROMPT = [
  'На снимке может быть официальный документ об ограничении или закрытии движения по дороге: приказ, распоряжение, постановление.',
  'Ответь ТОЛЬКО одним JSON-объектом без пояснений, без markdown:',
  '{"is_document": true|false, "kind": "приказ|распоряжение|постановление|уведомление", "issuer": "кто издал — как в шапке, коротко", "date": "ДД.ММ.ГГГГ", "number": "номер как написан", "title": "заголовок документа «Об ...»", "closed_until": "ДД.ММ.ГГГГ ЧЧ:ММ — до какого момента закрыто или ограничено движение", "road": "дорога и участок"}',
  'Чего не видно или не читается — null. Не придумывай и не достраивай. Фамилии и имена людей не выписывай.',
].join('\n');

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v ? v.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() : null));

const VisionAnswerSchema = z.object({
  is_document: z.boolean(),
  kind: nullableText(40),
  issuer: nullableText(160),
  date: nullableText(20),
  number: nullableText(30),
  title: nullableText(200),
  closed_until: nullableText(30),
  road: nullableText(200),
});

const KAMCHATKA_OFFSET_MS = 12 * 3_600_000;

/** «08.10.2026 18:00» по времени Камчатки → момент. Неразборчиво — null. */
export function parseKamchatkaDateTime(s: string | null | undefined): Date | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2})[:.\-](\d{2}))?$/.exec((s ?? '').trim());
  if (!m) return null;
  const [d, mo, y, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 23), Number(m[5] ?? 59)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  // 31.02 Date.UTC молча переносит на март — такой даты в документе нет.
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  // Без часа — конец дня: срок пункта им только продлевается, и поздний край
  // безопаснее раннего.
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - KAMCHATKA_OFFSET_MS);
}

/** Документ словами: «Приказ КГКУ "Камчатуправтодор" от 08.10.2026 № 122 «Об ограничении…»». */
export function composeBasisTitle(a: { kind: string | null; issuer: string | null; date: string | null; number: string | null; title: string | null }): string | null {
  if (!a.kind || !a.issuer || !(a.date || a.number)) return null;
  const kind = a.kind.charAt(0).toUpperCase() + a.kind.slice(1).toLowerCase();
  const parts = [`${kind} ${a.issuer}`];
  if (a.date) parts.push(`от ${a.date}`);
  if (a.number) parts.push(`№ ${a.number.replace(/^№\s*/, '')}`);
  let out = parts.join(' ');
  if (a.title) out += ` «${a.title.replace(/[«»"]/g, '').trim()}»`;
  return out.slice(0, 400);
}

/** Первый JSON-объект ответа модели — модели любят обрамлять его словами или ```. */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Прочитать основание со снимка. Три исхода: документ найден / на снимке не
 * документ (или главное не читается) / зрение не ответило.
 */
export async function readBasisFromImage(
  imageBase64: string,
  mimeType: string,
  vision: typeof callVisionDetailed = callVisionDetailed,
): Promise<BasisReading> {
  let text: string | null;
  try {
    const result = await vision(imageBase64, mimeType, VISION_PROMPT);
    text = result.text;
    if (!text) {
      const why = result.legs.map((l) => `${l.provider}: ${l.outcome}`).join('; ');
      return { outcome: 'unavailable', reason: `зрение не ответило (${why || 'ступеней нет'})` };
    }
  } catch (err) {
    return { outcome: 'unavailable', reason: `зрение упало: ${err instanceof Error ? err.message.slice(0, 200) : 'ошибка'}` };
  }
  const parsed = VisionAnswerSchema.safeParse(firstJsonObject(text));
  if (!parsed.success) return { outcome: 'no_document', reason: 'ответ модели — не JSON нужной формы' };
  const a = parsed.data;
  if (!a.is_document) return { outcome: 'no_document', reason: 'на снимке не документ' };
  const title = composeBasisTitle(a);
  if (!title) return { outcome: 'no_document', reason: 'вид документа, издатель, дата или номер не читаются' };
  const until = parseKamchatkaDateTime(a.closed_until);
  // Неправдоподобный срок (год ошибся, прошлое двухнедельной давности, полгода
  // вперёд) — не срок: основание остаётся, продление — нет.
  const now = Date.now();
  const plausible = until && until.getTime() > now - 14 * 86_400_000 && until.getTime() < now + 60 * 86_400_000;
  return { outcome: 'found', title, validUntil: plausible ? until : null };
}
