import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isDesktop =
  process.env.GUBIM_DESKTOP === '1' || Boolean(process.env.TAURI_ENV_PLATFORM);

export default defineConfig({
  base: isDesktop ? './' : process.env.NODE_ENV === 'production' ? '/VisorGuBIMGal/' : '/',
  plugins: [react()],
  server: {
    watch: {
      ignored: ['**/target/**', '**/handoff/**', '**/src-tauri/target/**'],
    },
  },
  worker: {
    format: 'es',
  },
});
