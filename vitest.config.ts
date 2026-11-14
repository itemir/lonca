import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Nowhere for Slack, so that no test can reach it. Those about Slack give their stand-in's address.
    env: { LONCA_HOME: path.join(os.tmpdir(), 'lonca-unit-tests'), LONCA_SLACK_API_URL: 'http://127.0.0.1:9/slack-api' },
    include: ['tests/unit/**/*.test.ts'],
  },
});
