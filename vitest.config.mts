import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2026-08-22', compatibilityFlags: ['nodejs_compat'] } })],
});
