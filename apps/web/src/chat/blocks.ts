/**
 * What a turn shows under its answer, once. The same file can come back as a
 * card from the action that saved it and again from the finished-work store,
 * and a run of identical steps leaves identical receipts; one of each is enough.
 */
import { plainTitle } from '../experience/plain.ts';
import type { TurnBlock } from '../experience/reduce.ts';

type CardBlock = Extract<TurnBlock, { type: 'card' }>;
type ReceiptBlock = Extract<TurnBlock, { type: 'receipt' }>;

/** Two file cards with one name are one file; any other card also has to say the same. */
const cardKey = (block: CardBlock) => {
  const title = plainTitle(block.card.title).toLowerCase();
  return /^files?$/i.test(block.card.meta.trim())
    ? `file\n${title}`
    : [block.card.meta, title, ...block.card.facts.map((f) => `${f.label}=${f.value}`)].join('\n');
};

/** A receipt only says the same as another when neither can be undone. */
const receiptKey = (block: ReceiptBlock) =>
  block.receipt.undo || block.reversed
    ? null
    : [block.receipt.what, block.receipt.where, block.receipt.review?.reason ?? ''].join('\u0000');

export function shownBlocks(blocks: TurnBlock[]): TurnBlock[] {
  const cards = new Map<string, number>();
  const receipts = new Set<string>();
  const shown: TurnBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'card') {
      // A draft is its own thing even when two share a subject.
      if (block.card.primary_action?.kind === 'send') {
        shown.push(block);
        continue;
      }
      const key = cardKey(block);
      const at = cards.get(key);
      if (at === undefined) {
        cards.set(key, shown.length);
        shown.push(block);
      } else {
        // Keep the copy that can be opened, in the place the first one held.
        const kept = shown[at] as CardBlock;
        if (!kept.card.primary_action && block.card.primary_action) shown[at] = block;
      }
      continue;
    }
    if (block.type === 'receipt') {
      const key = receiptKey(block);
      if (key !== null) {
        if (receipts.has(key)) continue;
        receipts.add(key);
      }
    }
    shown.push(block);
  }
  return shown;
}
