import type { Job, Space } from '@melete/client';
import { client, unwrap } from '../api.ts';
import { Banner, Empty, formatTime, JobChip, waitingDetail } from '../components.tsx';
import { useLoad } from '../hooks.ts';

export function Home({ spaceId }: { spaceId: string | null }) {
  const jobs = useLoad<Job[]>(
    async () =>
      unwrap(
        await client.api.GET('/jobs', {
          params: { query: { ...(spaceId ? { space_id: spaceId } : {}), limit: 50 } },
        }),
      ).jobs,
    [spaceId],
  );
  const spaces = useLoad<Space[]>(
    async () => unwrap(await client.api.GET('/spaces', {})).spaces,
    [],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <p>
            Everything you have delegated, and what each one is waiting on. A job survives the tab
            being closed.
          </p>
        </div>
        <a className="button button-primary" href="#/chat">
          Delegate something
        </a>
      </div>

      <Banner message={jobs.error} />

      {jobs.loading && !jobs.data ? (
        <Empty>Loading.</Empty>
      ) : !jobs.data?.length ? (
        <Empty>
          Nothing delegated yet. <a href="#/chat">Start a job</a> and close the tab.
        </Empty>
      ) : (
        <div className="stack">
          {jobs.data.map((job) => {
            const detail = waitingDetail(job.wait);
            return (
              <article className="card" key={job.id}>
                <div className="card-head">
                  <h2>
                    <a href={`#/jobs/${job.id}`}>{job.title}</a>
                  </h2>
                  <JobChip state={job.state} />
                </div>
                <p>{job.objective}</p>
                {detail ? <p className="muted">{detail}</p> : null}
                <p className="muted">
                  Started {formatTime(job.created_at)} · revision {job.revision} · epoch{' '}
                  {job.lease_epoch}
                </p>
              </article>
            );
          })}
        </div>
      )}

      <article className="card">
        <div className="card-head">
          <h2>Spaces</h2>
          <button type="button" className="button button-small" onClick={spaces.reload}>
            Refresh
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Repository</th>
              </tr>
            </thead>
            <tbody>
              {(spaces.data ?? []).map((space) => (
                <tr key={space.id}>
                  <td>{space.name}</td>
                  <td>{space.kind}</td>
                  <td className="mono">{space.git_path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </>
  );
}
