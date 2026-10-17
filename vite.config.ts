import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function fixIfcLiteWorkersPlugin() {
  return {
    name: 'fix-ifc-lite-workers',
    transform(code: string, id: string) {
      if (id.includes('@ifc-lite') && code.includes('geometry.worker.ts')) {
        return {
          code: code.replace(/geometry\.worker\.ts/g, 'geometry.worker.js'),
          map: null,
        };
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), fixIfcLiteWorkersPlugin()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@ifc-lite/wasm'],
  },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
});
