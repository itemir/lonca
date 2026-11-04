import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { LONCA_HOME: path.join(os.tmpdir(), 'lonca-unit-tests') },
    include: ['tests/unit/**/*.test.ts'],
  },
});
