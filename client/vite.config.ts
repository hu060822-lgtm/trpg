import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// GitHub Pages serves the site under /<repo>/; the deploy workflow sets VITE_BASE to that path.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: { fs: { allow: ['..'] } },
});
