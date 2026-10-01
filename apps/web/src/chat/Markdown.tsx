/**
 * An agent's answer drawn from its Markdown. Prose stays in the voice face;
 * code, terminal output and tables are set in the interface and mono faces.
 * Everything is drawn as React text, so nothing in a reply becomes markup.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { type Block, type Inline, inlineMarks, parseMarkdown } from '../experience/markdown.ts';

function Marks({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines of one block, in order
        <span key={at}>
          {at > 0 ? <br /> : null}
          {inlineMarks(line).map((span, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: spans of one line, in order
            <Mark key={index} span={span} />
          ))}
        </span>
      ))}
    </>
  );
}

function Mark({ span }: { span: Inline }) {
  if (span.kind === 'strong') return <strong>{span.text}</strong>;
  if (span.kind === 'em') return <em>{span.text}</em>;
  if (span.kind === 'code') return <code className="answer-code">{span.text}</code>;
  if (span.kind === 'link')
    return (
      <a
        className="answer-link"
        href={span.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        {span.text}
      </a>
    );
  return <>{span.text}</>;
}

/** A code block with its language, or "Terminal", and a copy button. */
function CodeBlock({ block }: { block: Extract<Block, { type: 'code' }> }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const label = block.terminal ? 'Terminal' : block.lang || 'Code';
  return (
    <div className="answer-pre" data-terminal={block.terminal ? 'true' : undefined}>
      <div className="answer-pre-head">
        <span>{label}</span>
        <button
          type="button"
          className="answer-pre-copy"
          aria-label={copied ? 'Copied' : `Copy ${block.terminal ? 'terminal output' : 'code'}`}
          onClick={() => {
            void navigator.clipboard?.writeText(block.text).then(() => {
              setCopied(true);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a wide block scrolls sideways, so it takes focus for the keyboard */}
      <pre tabIndex={0}>
        <code>{block.text}</code>
      </pre>
    </div>
  );
}

function BlockView({ block, caret }: { block: Block; caret: ReactNode }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <p>
          <Marks text={block.lines.join('\n')} />
          {caret}
        </p>
      );
    case 'heading': {
      const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1] ?? 'h5';
      return (
        <Tag className="answer-heading" data-level={block.level}>
          <Marks text={block.text} />
          {caret}
        </Tag>
      );
    }
    case 'rule':
      return <hr className="answer-rule" />;
    case 'code':
      return <CodeBlock block={block} />;
    case 'quote':
      return (
        <blockquote className="answer-quote">
          <Blocks blocks={block.children} caret={caret} />
        </blockquote>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items of one list, in order
        <li key={index} data-task={item.checked === null ? undefined : 'true'}>
          {item.checked !== null ? (
            <span
              className="answer-task"
              data-done={item.checked ? 'true' : undefined}
              role="img"
              aria-label={item.checked ? 'Done' : 'Not done'}
            >
              {item.checked ? <Icon name="check" size={11} stroke={3} /> : null}
            </span>
          ) : null}
          <span className="answer-li-text">
            <Marks text={item.text} />
          </span>
          {item.children.length ? <Blocks blocks={item.children} caret={null} /> : null}
          {index === block.items.length - 1 ? caret : null}
        </li>
      ));
      return block.ordered ? (
        <ol className="answer-list" start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul className="answer-list">{items}</ul>
      );
    }
    case 'table':
      return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a wide table scrolls sideways, so it takes focus for the keyboard
        <div className="answer-table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {block.head.map((cell, column) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns of one table, in order
                  <th key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                    <Marks text={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows of one table, in order
                <tr key={at}>
                  {row.map((cell, column) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns of one row, in order
                    <td key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                      <Marks text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

function Blocks({ blocks, caret }: { blocks: Block[]; caret: ReactNode }) {
  return (
    <>
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are a cut of one string, in order
        <BlockView key={index} block={block} caret={index === blocks.length - 1 ? caret : null} />
      ))}
    </>
  );
}

/** The answer, with a blinking caret after its last words while it streams. */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = parseMarkdown(text);
  const caret = streaming ? <span className="caret pulse" aria-hidden="true" /> : null;
  // An empty answer still holds its line, so the caret has somewhere to sit.
  if (blocks.length === 0) blocks.push({ type: 'paragraph', lines: [''] });
  // A caret cannot sit inside a code block or table, so it follows them.
  const last = blocks.at(-1);
  const trailing = last?.type === 'code' || last?.type === 'table' || last?.type === 'rule';
  return (
    <div className="answer">
      <Blocks blocks={blocks} caret={trailing ? null : caret} />
      {trailing && caret ? <p>{caret}</p> : null}
    </div>
  );
}
