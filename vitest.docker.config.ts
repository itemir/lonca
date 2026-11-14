import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Runs against a real Docker daemon, so it's slow and kept out of `npm test`.
export default defineConfig({
  test: {
    env: { LONCA_HOME: path.join(os.tmpdir(), 'lonca-docker-tests'), LONCA_SLACK_API_URL: 'http://127.0.0.1:9/slack-api' },
    include: ['tests/docker/**/*.test.ts'],
    testTimeout: 180000,
    hookTimeout: 600000,
    fileParallelism: false,
  },
});
