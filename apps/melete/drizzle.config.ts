import { defineConfig } from 'drizzle-kit';

/**
 * `bun run db:generate` writes SQL into ./drizzle, which is committed. A fresh
 * install applies the reviewed SQL rather than generating migrations on the
 * operator's machine.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/db/schema.ts',
    './src/db/auth-schema.ts',
    './src/memory/schema.ts',
    './src/companies/schema.ts',
    './src/learning/schema.ts',
    './src/learning/proposal-schema.ts',
    './src/learning/evaluation-schema.ts',
    './src/spaces/schema.ts',
    './src/sandbox/schema.ts',
    './src/devices/schema.ts',
    './src/feedback/schema.ts',
    './src/privacy/schema.ts',
    './src/egress/schema.ts',
    './src/storage/schema.ts',
    './src/apps/schema.ts',
    './src/ops/schema.ts',
    './src/rooms/schema.ts',
    './src/attachments/schema.ts',
    './src/signals/schema.ts',
    './src/triage/schema.ts',
    './src/situations/schema.ts',
    './src/intents/schema.ts',
    './src/reach/schema.ts',
    './src/paths/schema.ts',
  ],
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://melete:melete@localhost:5432/melete',
  },
});
