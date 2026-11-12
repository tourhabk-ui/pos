/**
 * Очередь менеджера в чате администратора (план «после отказа», этап 3б-2).
 *
 * Та же очередь, что на странице /hub/admin/queue (lib/manager-queue): три
 * рода случаев, где человеку после отказа нужен звонок или замена. В MAX её
 * открывает слово «очередь» или кнопка «Очередь после отказа» под «Заявками».
 * Под списком — кнопки «Взял N»: отметка, что случаем занимается этот
 * администратор. Одно нажатие, без «Да»: отметка не меняет заявку и снимается
 * на сайте («Вернуть в очередь»).
 *
 * ПД: в списке — имя и телефон клиента. Ответ помечен `pd: true` и уходит
 * только в личный чат администратора в MAX (lib/max/admin-chat, sendPdAlert);
 * в Telegram вместо него — строка «контакты только в MAX» (lib/roles/
 * role-screen). Ответ на нажатие «Взял» ПД не несёт: в нём нет ни имени
 * клиента, ни слов из заявки.
 *
 * Три исхода у каждого рода (§4.0): случаи есть, никого нет, «не прочиталось» —
 * и третий назван в тексте, а не выдан за второй.
 *
 * Список режется по пределу одного сообщения MAX, и кнопка «Взял N» ставится
 * только случаю, строка которого в сообщение вошла: отметить случай, которого
 * администратор не видит, нельзя. Сколько случаев не вошло — названо числом.
 * Строка о не прочитавшейся части и подсказка под списком не режутся.
 */
import { escapeHtml } from '@/lib/text/escape-html';
import { menuRows, type MenuButton } from '@/lib/roles/chat-menu';
import { adminActionReply, adminQueueTakePayload, type AdminActionReply } from '@/lib/max/admin-actions';
import { ADMIN_MAX_MESSAGE_CHARS, type AdminReply } from '@/lib/max/admin-read';
import { loadManagerQueue, takeQueueItem, type TakeOutcome } from '@/lib/manager-queue/queue';
import { QUEUE_KINDS, type ManagerQueue, type QueueItem, type QueueKind } from '@/lib/manager-queue/types';
import { QUEUE_SECTION, kamchatkaStamp, queueStateLines, queueSubjectLine } from '@/lib/manager-queue/words';

/** Сколько случаев списка получают кнопку «Взял N». */
export const ADMIN_QUEUE_BUTTONS = 6;
/** Имя клиента длиннее этого обрезается: телефон обязан остаться в строке. */
export const ADMIN_QUEUE_NAME_CHARS = 80;
/** Строка случая длиннее этого обрезается: направление поездки — свободный ввод заказчика. */
export const ADMIN_QUEUE_ITEM_CHARS = 600;
/** Запас под строку «…и ещё N». */
const CUT_NOTE_RESERVE = 80;

export const ADMIN_QUEUE_TEXT = {
  empty: 'В очереди после отказа никого нет: звонка никто не ждёт.',
  failed: 'Очередь не прочиталась: база не ответила. Это не «никого нет» — спросите чуть позже.',
  hint: 'Кнопка «Взял N» — отметка, что случаем занимаетесь вы: второй администратор её увидит. Снять её можно на сайте, в «Очереди менеджера».',
  buttonsLabel: 'Отметить случай из очереди выше:',
  taken: 'Отмечено: случай взяли вы. Вернуть его в очередь можно на сайте, в «Очереди менеджера».',
  gone: 'Этого случая в очереди уже нет: сообщение дошло или заявка изменилась. Напишите «очередь» — покажу свежий список.',
  notSaved: 'Отметка не записалась — нажмите ещё раз.',
} as const;

function sourceFailed(kind: QueueKind): string {
  return `<b>${escapeHtml(QUEUE_SECTION[kind].title)}</b> — эта часть не прочиталась: сбой, а не «никого нет».`;
}

/** Обрезка по символам, а не по половинкам пар: строка уходит в сообщение. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** Одна строка случая: кому звонить, что за заявка, что ответил партнёр. */
function itemLine(mark: string, i: QueueItem): string {
  const name = i.contact_name ? clip(String(i.contact_name), ADMIN_QUEUE_NAME_CHARS) : null;
  const who = [name, i.contact_phone].filter(Boolean).join(', ') || 'контакт не записан';
  const line = `${who} · ${queueSubjectLine(i)} · ${queueStateLines(i).join(' ')}`;
  return `${mark} ${escapeHtml(clip(line, ADMIN_QUEUE_ITEM_CHARS))}`;
}

/** Строка списка: случай (может не войти в сообщение) или строка, которая обязана остаться. */
interface Row { text: string; must: boolean; button?: MenuButton }

/** Текст очереди и кнопки «Взял N» — из уже прочитанной очереди. Без базы: судится вызовом. */
export function adminQueueReply(q: ManagerQueue, limit: number = ADMIN_MAX_MESSAGE_CHARS): AdminReply {
  const failedKinds = QUEUE_KINDS.filter((k) => q[k].state === 'failed');
  if (failedKinds.length === QUEUE_KINDS.length) return { text: ADMIN_QUEUE_TEXT.failed, pd: false };

  const rows: Row[] = [];
  let waitingTotal = 0;
  let takenTotal = 0;
  let more = false;
  for (const kind of QUEUE_KINDS) {
    const source = q[kind];
    if (source.state === 'failed') { rows.push({ text: sourceFailed(kind), must: true }); continue; }
    more = more || source.more;
    const items = source.items as QueueItem[];
    takenTotal += items.filter((i) => i.take).length;
    const waiting = items.filter((i) => !i.take);
    const title = `<b>${escapeHtml(QUEUE_SECTION[kind].title)}</b>`;
    waiting.forEach((item, at) => {
      waitingTotal++;
      // Номер строки — номер кнопки «Взял N» (первые ADMIN_QUEUE_BUTTONS).
      const numbered = waitingTotal <= ADMIN_QUEUE_BUTTONS;
      const line = itemLine(numbered ? `${waitingTotal}.` : '•', item);
      rows.push({
        // Заголовок рода едет с первым своим случаем: без случая он в тексте не остаётся.
        text: at === 0 ? `${title}\n${line}` : line,
        must: false,
        button: numbered ? { text: `Взял ${waitingTotal}`, payload: adminQueueTakePayload(kind, item.id) } : undefined,
      });
    });
  }

  const tail: string[] = [];
  if (takenTotal > 0) tail.push(`Уже взято: ${takenTotal} — кто взял, видно на сайте, в «Очереди менеджера».`);
  if (more) tail.push('Разобраны только последние случаи — более ранние в список не попали.');

  if (waitingTotal === 0) {
    // Никого не ждёт — но не прочитавшаяся часть очереди названа: «никого нет» сказано только о прочитанном.
    const head = failedKinds.length > 0 ? 'В прочитанных частях очереди после отказа никого нет.' : ADMIN_QUEUE_TEXT.empty;
    return { text: [head, ...rows.map((r) => r.text), ...tail].join('\n'), pd: false };
  }

  const out = [
    `<b>Очередь после отказа — ждут: ${waitingTotal}</b>`,
    'Кому после отказа нужен звонок или замена.',
  ];
  tail.push(ADMIN_QUEUE_TEXT.hint);
  // Место под строки, которые обязаны остаться, занято заранее: случаи делят остаток.
  const kept = [...rows.filter((r) => r.must).map((r) => r.text), ...tail];
  let size = [...out, ...kept].join('\n').length;
  const buttons: MenuButton[] = [];
  let hidden = 0;
  for (const row of rows) {
    if (row.must) { out.push(row.text); continue; }
    // Не вошёл один — не входят и следующие: список остаётся подряд, без пропусков.
    if (hidden === 0 && size + row.text.length + 1 <= limit - CUT_NOTE_RESERVE) {
      out.push(row.text);
      size += row.text.length + 1;
      // Кнопка — только случаю, строка которого в сообщении есть.
      if (row.button) buttons.push(row.button);
    } else {
      hidden++;
    }
  }
  if (hidden > 0) out.push(`…и ещё ${hidden} — в сообщение не вошли: они на сайте, в «Очереди менеджера».`);
  return {
    text: [...out, ...tail].join('\n'),
    pd: true,
    ...(buttons.length > 0 ? { buttons: menuRows(buttons), buttonsLabel: ADMIN_QUEUE_TEXT.buttonsLabel } : {}),
  };
}

/** «Очередь» администратора: чтение и текст. */
export async function readAdminQueue(): Promise<AdminReply> {
  return adminQueueReply(await loadManagerQueue());
}

/** Что сказать после нажатия «Взял N». ПД здесь нет: ни имени клиента, ни слов заявки. */
export function adminTakeText(o: TakeOutcome): string {
  switch (o.kind) {
    case 'taken':
      return ADMIN_QUEUE_TEXT.taken;
    case 'already': {
      const when = new Date(o.at);
      const at = Number.isNaN(when.getTime()) ? '' : ` — ${kamchatkaStamp(when)} по Камчатке`;
      return o.mine
        ? `Этот случай уже взяли вы${at}.`
        : `Этот случай уже взял другой администратор: ${escapeHtml(o.by ?? 'имя не записано')}${at}.`;
    }
    case 'not_in_queue':
      return ADMIN_QUEUE_TEXT.gone;
    case 'failed':
      return ADMIN_QUEUE_TEXT.notSaved;
  }
}

/**
 * Нажатие «Взял N». Права администратора уже проверены вызывающим
 * (handleAdminPress): кто взял — аккаунт, привязанный к этому MAX.
 */
export async function takeFromAdminChat(adminUserId: string, kind: QueueKind, id: string): Promise<AdminActionReply> {
  const outcome = await takeQueueItem({ kind, id, userId: adminUserId, via: 'max' });
  return adminActionReply(adminTakeText(outcome));
}
