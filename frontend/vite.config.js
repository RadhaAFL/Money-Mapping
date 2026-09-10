import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'esnext',
  },
  base: '/moneymapping/',
  server: {
    port: 3000,
    proxy: {
      '/moneymapping-api': {
        target: 'http://localhost:5002',
        rewrite: (path) => path.replace(/^\/moneymapping-api/, ''),
      },
    },
  },
})
