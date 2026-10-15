/**
 * Строка «последняя заявка» в карточке оператора в админке: дошла ли она до
 * оператора лично. Данные — lib/leads/delivery-outcome (журнал заявки), а не
 * догадка: владелец 15.10 спросил «точно приходят или опять предположения?»,
 * и ответить по данным было нечем.
 *
 * Три состояния данных: итог есть / записей нет / прочитать не удалось.
 */

export interface LeadDeliveryView {
  at: string;
  state: 'delivered' | 'stub' | 'failed' | 'no_channel' | 'unknown';
  channel: string | null;
  reason: string | null;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'время не записано';
  return `${d.toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} по Камчатке`;
}

function verdict(v: LeadDeliveryView): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  switch (v.state) {
    case 'delivered':
      return { text: 'доставлена лично в MAX', tone: 'ok' };
    case 'stub':
      return { text: 'в Telegram ушло уведомление без имени и телефона — они в кабинете', tone: 'ok' };
    case 'failed':
      return { text: `лично не доставлена${v.channel ? ` (${v.channel})` : ''}: ${v.reason ?? 'причина не записана'}`, tone: 'bad' };
    case 'no_channel':
      return { text: 'лично не отправлялась: у оператора не было ни MAX, ни Telegram', tone: 'warn' };
    case 'unknown':
    default:
      return { text: 'лично не отправлялась: адрес оператора не прочитался', tone: 'warn' };
  }
}

export function LeadDeliveryLine({ delivery }: { delivery: LeadDeliveryView | null | undefined }) {
  if (delivery === undefined) {
    return (
      <p className="text-xs text-[var(--warning)]">
        Последняя заявка: итог доставки не удалось прочитать.
      </p>
    );
  }
  if (delivery === null) {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        Последняя заявка: записей о доставке нет. Итог записывается с 15.10, заявок с тех пор не было.
      </p>
    );
  }
  const v = verdict(delivery);
  const cls = v.tone === 'ok' ? 'text-[var(--success)]' : v.tone === 'bad' ? 'text-[var(--danger)]' : 'text-[var(--warning)]';
  return (
    <p className={`text-xs ${cls}`}>
      Последняя заявка, {when(delivery.at)}: {v.text}.
    </p>
  );
}
