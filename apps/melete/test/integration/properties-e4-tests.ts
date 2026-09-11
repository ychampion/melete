/**
 * E4. An address extracted from a fetched page resolves as external content and
 * says so in words a person can read; the same address, stated by the owner,
 * resolves as the owner. Nothing about the value itself decides this.
 */
import { describe, expect, test } from 'bun:test';
import { recall } from '../../src/memory/recall.ts';
import { createTrustResolver } from '../../src/memory/trust.ts';
import { buildViews } from '../../src/memory/views.ts';
import { createScope, type TestDatabase } from './postgres.ts';
import { head, record } from './properties-fixtures.ts';

export function registerTrustTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('E4 trust class travels from evidence', () => {
    test('a page-sourced address is external content; the same address from the owner is not', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const address = 'billing@vendor.example';
      await record(
        db,
        scope,
        {
          identity: 'page-1',
          text: `Pay invoices to ${address} within 30 days.`,
          eventAt: '2026-09-11T09:00:00Z',
          sourceType: 'document',
          author: 'external',
          stream: 'web',
        },
        [
          {
            key: 'contact.vendor.email',
            content: address,
            quote: address,
            kind: 'document_assertion',
          },
        ],
      );
      const fromPage = await head(db, scope, 'contact.vendor.email');
      expect(fromPage?.origin_trust).toBe('external_content');

      const resolver = createTrustResolver(db.sql, async () => scope);
      const page = await resolver.resolve({
        space_id: scope.spaceId,
        payload: { to: address, amount: '400.00' },
        handles: [`${fromPage?.id}@${fromPage?.head_revision}`],
      });
      expect(page.fields[0]).toMatchObject({
        field: 'to',
        origin_trust: 'external_content',
        description: 'this address came from a web page fetched on 11 September',
      });
      expect(page.minimum_trust).toBe('external_content');
      // Untrusted origin can never satisfy the broker's admission rule on its own.
      expect(page.actionable).toBe(false);
      expect(page.unresolved).toContain('amount');

      await record(
        db,
        scope,
        {
          identity: 'said-1',
          text: `Their billing address is ${address}, I checked it with them.`,
          eventAt: '2026-09-11T12:00:00Z',
        },
        [
          {
            key: 'contact.vendor-confirmed.email',
            content: address,
            quote: address,
            kind: 'user_statement',
          },
        ],
      );
      const fromOwner = await head(db, scope, 'contact.vendor-confirmed.email');
      expect(fromOwner?.origin_trust).toBe('owner');
      const owner = await resolver.resolve({
        space_id: scope.spaceId,
        payload: { to: address },
        handles: [`${fromOwner?.id}@${fromOwner?.head_revision}`],
      });
      expect(owner.fields[0]).toMatchObject({
        origin_trust: 'owner',
        description: 'this address came from something you said on 11 September',
      });
      expect(owner.actionable).toBe(true);

      // The Markdown view shows both, so a person can see it without the API.
      await buildViews(db.sql, scope);
      const items = (await recall(db.sql, scope, { query: 'vendor' })).items;
      expect(items.find((item) => item.key === 'contact.vendor.email')?.origin_trust).toBe(
        'external_content',
      );
      expect(
        items.find((item) => item.key === 'contact.vendor-confirmed.email')?.origin_trust,
      ).toBe('owner');
    });
  });
}
