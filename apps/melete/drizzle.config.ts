import { defineConfig } from 'drizzle-kit';

/**
 * `bun run db:generate` writes SQL into ./drizzle, which is committed. A fresh
 * install applies the reviewed SQL rather than generating migrations on the
 * operator's machine.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://melete:melete@localhost:5432/melete',
  },
});
