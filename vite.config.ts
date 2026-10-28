import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5180, open: false, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4180, allowedHosts: true },
  build: { target: 'es2020' },
})
