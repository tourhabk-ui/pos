/**
 * «Юридическая информация» на странице оператора — вместе с номером в реестре
 * туроператоров (владелец 13.10: «где у операторов номер в реестре?»).
 *
 * Номер лежит в partners.registry_number с миграции 742, а страница
 * показывала его только всплывающей подсказкой над значком «В официальном
 * реестре» — и только после сверки с реестром (registry_status = verified),
 * которой не прошёл ни один оператор. На телефоне подсказки нет вовсе: номер
 * не видел никто, хотя у «Края Вулканов» и «Местечка Камчатки» он записан.
 *
 * Теперь номер — строкой реквизитов, и рядом сказано, чего он стоит (§4.0):
 * сверен с реестром (с датой), расходится с реестром, в реестре не найден —
 * или «с реестром не сверен», если сверки не было. Номера нет — строки нет:
 * отсутствие записи у нас не значит отсутствия в реестре.
 *
 * Здесь же — строка о записанном согласии партнёра на материалы его сайта
 * (миграция 1321): только при неотозванной записи, на его собственной
 * странице, как у перевозчика и прокатчика (§0, перепись 23.10 нашла, что у
 * туроператора её не было).
 *
 * Сторожа: tests/unit/operator-legal-info.test.tsx,
 * tests/unit/partner-materials-consent.test.tsx.
 */

import type { LegalInfo } from '@/lib/operators/profile-parse';
import { materialsConsentLine, type MaterialsConsentPublic } from '@/lib/legal/partner-materials-consent';

interface Props {
  legal: LegalInfo | string | null;
  registryNumber: string | null;
  /** partners.registry_status: unknown | verified | not_found | mismatch. */
  registryStatus: string | null;
  /** Дата последней сверки, «ДД.ММ.ГГГГ»; нет — null. */
  registryCheckedAt: string | null;
  /** Действующее согласие партнёра на материалы сайта; нет записи — null. */
  materialsConsent?: MaterialsConsentPublic | null;
}

function registryNote(status: string | null, checkedAt: string | null): { text: string; warn: boolean } {
  switch (status) {
    case 'verified':
      return { text: checkedAt ? `сверен с реестром ${checkedAt}` : 'сверен с реестром', warn: false };
    case 'mismatch':
      return { text: 'расходится с данными реестра', warn: true };
    case 'not_found':
      return { text: 'в реестре не найден', warn: true };
    default:
      return { text: 'с реестром не сверен', warn: false };
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[var(--text-muted)] text-xs uppercase tracking-wide">{label}</dt>
      <dd className="text-[var(--text-secondary)]">{children}</dd>
    </div>
  );
}

export function OperatorLegalInfo({ legal, registryNumber, registryStatus, registryCheckedAt, materialsConsent }: Props) {
  const number = registryNumber?.trim() || null;
  if (!legal && !number && !materialsConsent) return null;
  const note = number ? registryNote(registryStatus, registryCheckedAt) : null;

  return (
    <section className="ds-card p-5">
      <h2 className="font-playfair text-2xl font-bold mb-4">Юридическая информация</h2>
      {typeof legal === 'string' && (
        <p className="text-[var(--text-secondary)] leading-relaxed mb-3">{legal}</p>
      )}
      <dl className="space-y-2 text-sm">
        {legal && typeof legal !== 'string' && (
          <>
            {legal.companyName && (
              <div>
                <dt className="text-[var(--text-muted)] text-xs uppercase tracking-wide">Компания</dt>
                <dd className="font-medium text-[var(--text-primary)]">{legal.companyName}</dd>
              </div>
            )}
            {legal.inn && <Row label="ИНН">{legal.inn}</Row>}
            {legal.ogrn && <Row label="ОГРН">{legal.ogrn}</Row>}
            {legal.address && <Row label="Адрес">{legal.address}</Row>}
            {legal.license && <Row label="Лицензия">{legal.license}</Row>}
            {legal.fishingArea && <Row label="Рыболовный участок">{legal.fishingArea}</Row>}
          </>
        )}
        {number && note && (
          <Row label="Реестровый номер туроператора">
            {number}
            <span className={`block text-xs ${note.warn ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>{note.text}</span>
          </Row>
        )}
        {materialsConsent && (
          <Row label="Материалы сайта">
            <span data-testid="materials-consent">{materialsConsentLine(materialsConsent)}</span>
          </Row>
        )}
      </dl>
    </section>
  );
}
