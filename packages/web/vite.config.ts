import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Workspace packages resolve to their TypeScript sources, as in tests.
  resolve: { conditions: ['@pearcoderhq/source', ...defaultClientConditions] },
  build: { outDir: 'dist/app', emptyOutDir: true, sourcemap: true },
});
