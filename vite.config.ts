import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    host: '127.0.0.1',
    strictPort: false,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/three-mesh-bvh')) return 'bvh';
          if (id.includes('node_modules/postprocessing')) return 'postfx';
          if (id.includes('node_modules/3d-tiles-renderer')) return 'tiles';
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    include: ['three', 'three-mesh-bvh', 'postprocessing'],
  },
});
