import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Für GitHub-Pages-Projektseiten wird die App unter /<repo>/ ausgeliefert.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  server: { host: true },
  build: { target: 'es2022' },
});
