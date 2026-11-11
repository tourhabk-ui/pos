import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    setupFiles: ['./test/setup.ts'],
    // Хуки — до минуты, а не 10 с по умолчанию (11.11, kernel-pg на #3255).
    // pg-сцены удаляют свою базу в afterAll (`dropTestDatabase`, tests/helpers/
    // pg-schema.ts): DROP DATABASE ждёт принудительную контрольную точку, и на
    // загруженном раннере она шла 14 с — хук падал при 916 зелёных сценах. Лимит
    // только сверху: зависший хук по-прежнему краснеет, через минуту.
    hookTimeout: 60_000,
    exclude: ['node_modules', 'dist', '.next', 'test/e2e/**', '.claude/**', '_archive/**'],
    // Среда — по роду файла. Почти все тесты — серверный код (роуты, SQL,
    // сервисы), и в node он проверяется в своей настоящей среде; экран рисуют
    // файлы .tsx. До 14.10 jsdom стоял у всех: окружение браузера создавалось
    // для каждого из ~1700 файлов, и в логе CI #2458 фаза environment заняла
    // 70% суммарного времени воркеров (1630 с) при 885 с прогона.
    // Файл .ts, которому нужен DOM (window, localStorage), объявляет это первой
    // строкой: `// @vitest-environment jsdom`. Пометка в файле сильнее рода.
    projects: [
      { extends: true, test: { name: 'node', include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'], environment: 'node' } },
      { extends: true, test: { name: 'dom', include: ['**/*.{test,spec}.{jsx,tsx}'], environment: 'jsdom' } },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
        '**/.next/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      '@/lib': path.resolve(__dirname, './lib'),
      '@/app': path.resolve(__dirname, './app'),
      '@/components': path.resolve(__dirname, './components'),
      '@/types': path.resolve(__dirname, './types'),
    },
  },
});
