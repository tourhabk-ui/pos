'use client';

import { useBoundaryError } from '@/hooks/use-boundary-error';
import { CHUNK_TEXT, browserPage, chunkNoticeBody } from '@/lib/client-errors/chunk-load';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Падение корневого layout: window-перехватчик уже не живёт, докладывает
  // граница. Не догрузился кусок кода (06.11: таймаут на layout-чанке) — это
  // связь, а не «непредвиденная ошибка»: одна автоперезагрузка, честный экран.
  const { chunk, decision } = useBoundaryError(error);
  const reloading = chunk && decision === 'reload';
  return (
    <html lang="ru">
      <head>
        <style>{`
          :root {
            --bg-primary: #F5F5F5;
            --text-primary: #1A1A1A;
            --text-secondary: #595959;
            --text-muted: #6B6B6B;
            --accent: #006CE4;
          }
        `}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          backgroundColor: 'var(--bg-primary)',
          color: 'var(--text-primary)',
        }}
      >
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
            {chunk ? CHUNK_TEXT.title : 'Что-то пошло не так'}
          </h1>
          <p role="alert" style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', maxWidth: '400px' }}>
            {chunk ? chunkNoticeBody(decision) : 'Произошла непредвиденная ошибка. Попробуйте обновить страницу.'}
          </p>
          {!chunk && error.digest && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '1rem' }}>
              Код ошибки: {error.digest}
            </p>
          )}
          {!reloading && (
            <button
              type="button"
              onClick={chunk ? () => browserPage.reload() : reset}
              style={{
                padding: '0.75rem 2rem',
                backgroundColor: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: '0.75rem',
                fontSize: '1rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {chunk ? CHUNK_TEXT.button : 'Попробовать снова'}
            </button>
          )}
        </div>
      </body>
    </html>
  );
}
