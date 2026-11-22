import { Header } from '@/components/layout/Header';
import { SafetyIntro } from './SafetyAbout';

/** Пока грузится живая обстановка, в HTML уже есть вопрос и прямой ответ. */
export default function Loading() {
  return (
    <>
      <Header />
      <div className="ds-page px-4" style={{ maxWidth: 680, margin: '0 auto', paddingBottom: 96 }}>
        <SafetyIntro />
        <p role="status" className="text-sm" style={{ color: 'var(--text-muted)' }}>Загрузка обстановки…</p>
      </div>
    </>
  );
}
