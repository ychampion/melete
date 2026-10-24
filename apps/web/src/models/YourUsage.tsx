/**
 * Settings › Usage: what your own model calls came to this month. This month
 * and today against your limits (spending alone when there are none), a bar
 * for each day, what the money went to, and the work it went on, each piece
 * opening its chat. The figures are the service's estimates from its prices.
 */
import { LoadError } from '../design/LoadError.tsx';
import { useLoad } from '../experience/hooks.ts';
import { href } from '../router.ts';
import { type MyUsage, myUsage } from './api.ts';
import {
  backgroundCapLine,
  type CapRow,
  capRows,
  chartSummary,
  type DayBar,
  kindRows,
  money,
  monthBars,
  OUTCOME,
  whenRan,
} from './your-usage.ts';
import './your-usage.css';

function CapMeter({ row }: { row: CapRow }) {
  return (
    <div className="yu-cap" data-tone={row.tone}>
      <div className="yu-cap-head">
        <span className="yu-cap-label">{row.label}</span>
        <span className="yu-cap-figure">
          <strong>{row.spent}</strong>
          {row.limit ? <span className="yu-cap-limit"> {row.limit}</span> : null}
        </span>
      </div>
      {row.share !== null ? (
        // biome-ignore lint/a11y/useSemanticElements: a native meter cannot take the tone colours in every browser
        <div
          className="yu-meter"
          role="meter"
          aria-label={`${row.label}: ${row.spent} ${row.limit ?? ''}`.trim()}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(row.share * 100))}
        >
          <span style={{ width: `${Math.min(100, row.share * 100)}%` }} />
        </div>
      ) : null}
      {row.limit ? <span className="yu-cap-reset">{row.resets}</span> : null}
    </div>
  );
}

const CHART_HEIGHT = 96;

/** A bar a day for the month, background work stacked under chats. */
export function DayChart({ bars }: { bars: DayBar[] }) {
  const top = Math.max(...bars.map((bar) => bar.total), 0);
  const width = bars.length * 10;
  const scale = (usd: number) => (top > 0 ? (usd / top) * CHART_HEIGHT : 0);
  return (
    <figure className="yu-chart">
      <div className="yu-chart-top">
        <span>{top > 0 ? money(top) : '$0.00'}</span>
        <span className="yu-legend">
          <span className="yu-swatch" data-kind="chats" aria-hidden="true" />
          Chats
          <span className="yu-swatch" data-kind="background" aria-hidden="true" />
          Background
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={chartSummary(bars)}
      >
        <line x1={0} x2={width} y1={CHART_HEIGHT} y2={CHART_HEIGHT} className="yu-axis" />
        {bars.map((bar, index) => {
          const background = scale(bar.background);
          const chats = scale(bar.chats);
          const x = index * 10 + 2;
          return (
            <g key={bar.day} data-later={bar.later || undefined}>
              <title>{`${bar.label}: ${money(bar.total)}`}</title>
              {/* A day with any spending keeps a sliver, so it reads apart from none. */}
              {bar.total > 0 ? (
                <>
                  <rect
                    x={x}
                    width={6}
                    y={CHART_HEIGHT - background}
                    height={background}
                    className="yu-bar-background"
                  />
                  <rect
                    x={x}
                    width={6}
                    y={CHART_HEIGHT - background - Math.max(chats, 1.5)}
                    height={Math.max(chats, 1.5)}
                    className="yu-bar-chats"
                  />
                </>
              ) : (
                <rect
                  x={x}
                  width={6}
                  y={CHART_HEIGHT - 1}
                  height={1}
                  className={bar.later ? 'yu-bar-later' : 'yu-bar-none'}
                />
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="yu-chart-axis">
        <span>{bars[0]?.label}</span>
        <span>{bars.at(-1)?.label}</span>
      </figcaption>
    </figure>
  );
}

/** The usage page itself, from what the service answered. */
export function YourUsageView({ data, now = new Date() }: { data: MyUsage; now?: Date }) {
  const caps = capRows(data, now);
  const background = backgroundCapLine(data);
  const kinds = kindRows(data);
  return (
    <div className="your-usage">
      <section className="card-12 yu-section" aria-labelledby="yu-spend">
        <h2 id="yu-spend" className="yu-heading">
          {data.caps ? 'Your allowance' : 'Your spending'}
        </h2>
        <div className="yu-caps">
          {caps.map((row) => (
            <CapMeter key={row.label} row={row} />
          ))}
        </div>
        {background ? <p className="yu-note">Background work: {background}.</p> : null}
        {data.notice ? (
          <p className="yu-notice" role="status" data-level={data.notice.level}>
            {data.notice.message}
          </p>
        ) : null}
        <p className="yu-note">
          {data.caps
            ? 'Estimated from model prices. When a limit is reached, new requests wait until it starts again.'
            : 'Estimated from model prices.'}
        </p>
      </section>

      <section className="card-12 yu-section" aria-labelledby="yu-days">
        <h2 id="yu-days" className="yu-heading">
          Each day this month
        </h2>
        <DayChart bars={monthBars(data)} />
      </section>

      <section className="card-12 yu-section" aria-labelledby="yu-kinds">
        <h2 id="yu-kinds" className="yu-heading">
          Where it went
        </h2>
        <ul className="yu-kinds">
          {kinds.map((kind) => (
            <li key={kind.label}>
              <div className="yu-kind-text">
                <span className="yu-kind-label">{kind.label}</span>
                <span className="yu-kind-note">{kind.note}</span>
              </div>
              <span className="yu-kind-value">{kind.value}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card-12 yu-section" aria-labelledby="yu-runs">
        <h2 id="yu-runs" className="yu-heading">
          Recent work
        </h2>
        {data.runs.length ? (
          <ul className="yu-runs">
            {data.runs.map((run) => {
              const outcome = OUTCOME[run.outcome];
              const body = (
                <>
                  <span className="yu-run-text">
                    <span className="yu-run-title">{run.title}</span>
                    <span className="yu-run-when">
                      {whenRan(run.at, now)}
                      {run.background ? ' · in the background' : ''}
                    </span>
                  </span>
                  <span className="status-pill" data-tone={outcome.tone}>
                    <span className="status-dot" />
                    {outcome.label}
                  </span>
                  <span className="yu-run-cost">{money(run.usd)}</span>
                </>
              );
              return (
                <li key={run.id}>
                  {run.conversation_id ? (
                    <a className="yu-run" href={href(`/chat/${run.conversation_id}`)}>
                      {body}
                    </a>
                  ) : (
                    <div className="yu-run">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="yu-note">Nothing yet this month. Your chats and routines show up here.</p>
        )}
      </section>
    </div>
  );
}

export function YourUsageTab() {
  const loaded = useLoad(() => myUsage(), []);
  if (loaded.error)
    return <LoadError what="your usage" error={loaded.error} onRetry={loaded.reload} />;
  if (!loaded.data)
    return (
      <p className="yu-note" aria-live="polite">
        Loading your usage…
      </p>
    );
  return <YourUsageView data={loaded.data} />;
}
