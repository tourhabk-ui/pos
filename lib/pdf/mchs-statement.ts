/**
 * Лист с данными группы для заявки в МЧС — один генератор на форму `/register`
 * и на выдачу по номеру записи.
 *
 * До 10.11 генераторов было два, оба в роутах и оба шрифтом Helvetica, в
 * котором нет кириллицы: русский лист выходил нечитаемым, а экран говорил
 * «PDF-заявка скачана. Подайте её в МЧС» (docs/safety/MCHS_PLAN.md, С3).
 * Сторож шрифтов смотрит `lib/pdf` — поэтому генератор живёт здесь.
 *
 * Лист называет себя тем, что он есть: данные, которые человек ввёл сам. Это
 * не бланк МЧС и не заявление от Ведара — заявку подаёт руководитель группы
 * (решение владельца 30.09), и способы подачи берутся из одного модуля фактов.
 */

import PDFDocument from 'pdfkit';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { FONT_BODY, FONT_BOLD, registerCyrillicFonts } from '@/lib/pdf/fonts';
import { MCHS_WHO_SUBMITS } from '@/lib/safety/mchs-chat';
import { MCHS_CONTACTS_NEEDED, MCHS_NOT_IN_RECORD } from '@/lib/safety/mchs-form-text';
import {
  MCHS_AFTER_RETURN, MCHS_CHANNELS, MCHS_DEADLINE_SHORT, MCHS_RETURN_NOT_VIA_VEDAR,
} from '@/lib/safety/mchs-registration';

export interface MchsStatementMember {
  name: string;
  phone?: string | null;
  birth_year?: number | null;
}

export interface MchsStatementData {
  /** Номер записи контроля, если лист строится по сохранённой записи. */
  id?: string | null;
  routeName: string;
  routeDescription?: string | null;
  region: string;
  /** `YYYY-MM-DD` или дата из базы. */
  startDate: string | Date;
  endDate: string | Date;
  leaderName: string;
  leaderPhone: string;
  leaderEmail?: string | null;
  groupSize: number | string;
  members: MchsStatementMember[];
  contactName: string;
  contactPhone: string;
  contactRelation?: string | null;
}

export const MCHS_STATEMENT_TITLE = 'Данные туристской группы';
export const MCHS_STATEMENT_SUBTITLE = 'для заявки в ГУ МЧС России по Камчатскому краю';
export const MCHS_STATEMENT_NOT_A_FORM = 'Это не бланк МЧС и не подтверждение регистрации.';
export const MCHS_STATEMENT_ALSO_ASKED =
  'Памятка ГУ МЧС по краю просит указать в маршрутном листе больше, чем есть здесь. Впишите в заявку сами:';

/**
 * Чего в листе нет. Тот же перечень, что отдаёт «Скопировать данные для формы»
 * (lib/safety/mchs-form-text): две выдачи одних данных не должны расходиться.
 * Первая редакция печатала под этим заголовком весь перечень сведений — в том
 * числе ФИО и телефоны участников, которые в листе как раз есть. Экстренный
 * контакт в записи один, а памятка просит двух — это тоже названо.
 */
export function statementMissing(): string[] {
  return [
    `второе контактное лицо, которое не идёт в поход (нужно ${MCHS_CONTACTS_NEEDED}, в листе одно)`,
    ...MCHS_NOT_IN_RECORD,
  ];
}

/**
 * Подвал листа. Лист — единственное, что человек увезёт с собой, поэтому
 * строка о сообщении после возвращения стоит и здесь, вместе с тем, что
 * отметка «Я вернулся» в Ведаре в МЧС не уходит.
 */
export function statementFooter(): string {
  return (
    `Лист собран в Ведаре (vedarai.ru) из того, что ввёл руководитель группы. ${MCHS_STATEMENT_NOT_A_FORM} ` +
    `${MCHS_WHO_SUBMITS} ${MCHS_DEADLINE_SHORT}. Способы подачи: ${statementChannelsLine()}. ` +
    `${MCHS_AFTER_RETURN} ${MCHS_RETURN_NOT_VIA_VEDAR}`
  );
}

/**
 * День без игры поясов: строка `YYYY-MM-DD` переставляется как есть, дата из
 * базы читается местными полями — так её и собрал драйвер.
 */
export function statementDate(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '—';
    const d = String(value.getDate()).padStart(2, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    return `${d}.${m}.${value.getFullYear()}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—';
}

/** Способы подачи одной строкой — те же, что на экранах и в чате. */
export function statementChannelsLine(): string {
  return MCHS_CHANNELS.map((c) => `${c.title.toLowerCase()} — ${c.href ?? c.detail}`).join('; ');
}

/** Члены группы из записи: в базе это JSON, в форме — массив. Мусор — пустой список. */
export function statementMembers(raw: unknown): MchsStatementMember[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (err) {
      console.error('[mchs-statement] состав группы не разобран:', err instanceof Error ? err.name : 'unknown');
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: MchsStatementMember[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    out.push({
      name,
      phone: typeof rec.phone === 'string' && rec.phone.trim() ? rec.phone.trim() : null,
      birth_year: typeof rec.birth_year === 'number' ? rec.birth_year : null,
    });
  }
  return out;
}

export function generateMchsStatementPDF(data: MchsStatementData, now: Date = new Date()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 60 });
    registerCyrillicFonts(doc);

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const rule = () => {
      doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    };
    const field = (label: string, value: string) => {
      doc.fontSize(10).font(FONT_BOLD).text(label, { continued: true });
      doc.font(FONT_BODY).text(`  ${value.trim() || '—'}`);
    };

    doc.fontSize(16).font(FONT_BOLD).text(MCHS_STATEMENT_TITLE, { align: 'center' });
    doc.fontSize(11).font(FONT_BODY).text(MCHS_STATEMENT_SUBTITLE, { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(9).text(MCHS_STATEMENT_NOT_A_FORM, { align: 'center' });
    doc.moveDown(0.8);
    rule();
    doc.moveDown(0.5);

    field('Маршрут:', data.routeName);
    if ((data.routeDescription ?? '').trim()) field('Описание:', data.routeDescription ?? '');
    field('Регион:', data.region);
    field('Дата начала:', statementDate(data.startDate));
    field('Дата окончания:', statementDate(data.endDate));

    doc.moveDown(0.3);
    rule();
    doc.moveDown(0.5);

    field('Руководитель:', data.leaderName);
    field('Телефон руководителя:', data.leaderPhone);
    if ((data.leaderEmail ?? '').trim()) field('Email:', data.leaderEmail ?? '');
    field('Количество участников:', String(data.groupSize));

    if (data.members.length > 0) {
      doc.moveDown(0.3);
      rule();
      doc.moveDown(0.3);
      doc.fontSize(10).font(FONT_BOLD).text('Состав группы:');
      doc.font(FONT_BODY);
      data.members.forEach((m, i) => {
        const info = [m.birth_year ? `${m.birth_year} г.р.` : '', (m.phone ?? '').trim()].filter(Boolean).join(', ');
        doc.fontSize(10).text(`  ${i + 1}. ${m.name}${info ? ` (${info})` : ''}`);
      });
    }

    doc.moveDown(0.3);
    rule();
    doc.moveDown(0.5);

    field('Экстренный контакт:', data.contactName);
    field('Телефон:', data.contactPhone);
    if ((data.contactRelation ?? '').trim()) field('Кем приходится:', data.contactRelation ?? '');

    // Номер записи — началом: целиком он вместе с телефоном руководителя на
    // том же листе открывал бы чужому отметки возвращения.
    const idStart = (data.id ?? '').trim().slice(0, 8);
    if (idStart) {
      doc.moveDown(0.3);
      doc.fontSize(9).font(FONT_BODY).text(`Запись контроля возвращения в Ведаре: ${idStart}…`, { align: 'right' });
    }

    // Чего в листе нет: иначе человек решит, что переписал в заявку всё.
    doc.moveDown(0.8);
    doc.fontSize(9).font(FONT_BOLD).text(MCHS_STATEMENT_ALSO_ASKED);
    doc.font(FONT_BODY);
    statementMissing().forEach((item) => {
      doc.fontSize(9).text(`  — ${item}`);
    });

    doc.moveDown(1.2);
    rule();
    doc.moveDown(0.5);
    doc.fontSize(8).font(FONT_BODY).text(statementFooter(), { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(8).text(`Собрано: ${statementDate(kamchatkaDate(now))} (день по Камчатке)`, { align: 'left' });

    doc.end();
  });
}
