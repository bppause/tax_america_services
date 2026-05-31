import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const BUILD_TIME = new Date().toISOString();
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'write-build-meta',
      closeBundle() {
        const distDir = join(__dirname, 'dist');
        mkdirSync(distDir, { recursive: true });
        writeFileSync(join(distDir, 'build-meta.json'), JSON.stringify({ buildTime: BUILD_TIME }));
      },
    },
  ],
  // Inject build timestamp as a global constant — resolved at vite build time.
  // __BUILD_TIME__ is the ISO string of when `vite build` (or `vite dev`) ran.
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  // Allow Firebase ESM imports from gstatic CDN
  optimizeDeps: {
    exclude: []
  },
  build: {
    minify: false,
    reportCompressedSize: false,
  },
  server: {
    proxy: { '/api': 'http://localhost:3001' }
  }
})
