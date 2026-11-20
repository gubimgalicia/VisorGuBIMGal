import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/VisorGuBIMGal/' : '/',
  plugins: [react()],
  server: {
    watch: {
      ignored: ['**/target/**', '**/handoff/**'],
    },
  },
  worker: {
    format: 'es',
  },
});
