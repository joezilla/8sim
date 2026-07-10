import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    globals: false,
    // Load .env (no prefix filter) so live integration tests can read
    // FDCPLUS_URL / FDCPLUS_TOKEN — see .env.example.
    env: loadEnv(mode, process.cwd(), ''),
  },
}));
