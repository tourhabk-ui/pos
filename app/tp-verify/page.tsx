import type { Metadata } from 'next';

// Код подтверждения сайта для Travelpayouts: странице место в их проверке, не
// в выдаче (разбор SEO 13.10 — индексировалась с заголовком по умолчанию).
export const metadata: Metadata = {
  title: 'Подтверждение сайта',
  robots: { index: false, follow: false },
};

export default function TravelPayoutsVerify() {
  return (
    <div style={{ padding: '20px' }}>
      <p>2aafzv6xt87m06rb</p>
    </div>
  );
}
