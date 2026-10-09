/**
 * The person's own skills, under what Melete learned: each skill they asked
 * Melete to make, read whole, with its words to change and a way to delete it.
 * A change names the version the person was shown, so a skill Melete changed
 * since is never overwritten unseen.
 */
import { useState } from 'react';
import { ownSpaceId } from '../companies/api.ts';
import { Icon } from '../design/icons.tsx';
import { Button, Field, Input } from '../design/primitives.tsx';
import { adapter, type Result } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type { OwnSkill } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

type Loaded = { space: string; skills: OwnSkill[] };

async function loadOwnSkills(): Promise<Result<Loaded>> {
  const space = await ownSpaceId();
  if (space.data === null) return space;
  const listed = await adapter.ownSkills(space.data);
  if (listed.data === null) return listed;
  return {
    data: { space: space.data, skills: listed.data.skills },
    error: null,
    unavailable: null,
  };
}

/** Triggers as the person types them: one phrase per comma. */
const phrases = (value: string) =>
  value
    .split(',')
    .map((phrase) => phrase.trim())
    .filter(Boolean);

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function OwnSkillRow({
  skill,
  busy,
  onSave,
  onDelete,
}: {
  skill: OwnSkill;
  busy: boolean;
  onSave: (change: { description: string; triggers: string[]; body: string }) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [description, setDescription] = useState(skill.description);
  const [triggers, setTriggers] = useState(skill.triggers.join(', '));
  const [body, setBody] = useState(skill.body);
  const bodyId = `skill-body-${skill.name}`;
  const startEditing = () => {
    setDescription(skill.description);
    setTriggers(skill.triggers.join(', '));
    setBody(skill.body);
    setEditing(true);
  };
  return (
    <div
      className="col"
      style={{ gap: 8, padding: '12px 14px', borderTop: '1px solid var(--line)' }}
    >
      <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <span
          className="row"
          style={{
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'var(--blue-soft)',
            color: 'var(--blue-ink)',
            flexShrink: 0,
          }}
        >
          <Icon name="sparkles" size={14} />
        </span>
        <div className="col grow" style={{ gap: 4, minWidth: 200 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--heading)',
              overflowWrap: 'anywhere',
            }}
          >
            {skill.name}
          </span>
          {editing ? (
            <form
              className="col"
              style={{ gap: 10 }}
              onSubmit={(event) => {
                event.preventDefault();
                const next = {
                  description: description.trim(),
                  triggers: phrases(triggers),
                  body: body.trim(),
                };
                if (!next.description || !next.triggers.length || !next.body) {
                  toast({ kind: 'err', title: 'A skill needs a description, a trigger and steps' });
                  return;
                }
                void onSave(next).then((ok) => ok && setEditing(false));
              }}
            >
              <Field label="What it does">
                <Input
                  value={description}
                  maxLength={300}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <Field label="Comes up when you say" hint="Separate phrases with commas.">
                <Input value={triggers} onChange={(event) => setTriggers(event.target.value)} />
              </Field>
              <label className="col" style={{ gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
                  Steps
                </span>
                <textarea
                  className="textarea"
                  value={body}
                  maxLength={1400}
                  rows={6}
                  onChange={(event) => setBody(event.target.value)}
                />
              </label>
              <span className="row" style={{ gap: 8 }}>
                <Button size="sm" type="submit" loading={busy} disabled={busy}>
                  Save changes
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </span>
            </form>
          ) : (
            <>
              <span style={{ fontSize: 14, color: 'var(--text)', overflowWrap: 'anywhere' }}>
                {skill.description}
              </span>
              {skill.triggers.length ? (
                <span style={{ fontSize: 13, color: 'var(--secondary)' }}>
                  When you ask to {skill.triggers.map((phrase) => `“${phrase}”`).join(' or ')}
                </span>
              ) : null}
              {open ? (
                <pre
                  id={bodyId}
                  style={{
                    margin: 0,
                    padding: '10px 12px',
                    borderRadius: 10,
                    background: 'var(--soft)',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    lineHeight: '20px',
                    color: 'var(--text)',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {skill.body}
                </pre>
              ) : null}
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                Your skill · changed {dateOf(skill.updated_at)}
              </span>
            </>
          )}
          {deleting ? (
            <div
              className="col"
              style={{
                gap: 8,
                fontSize: 13,
                color: 'var(--secondary)',
                padding: '8px 12px',
                borderRadius: 10,
                background: 'var(--soft)',
              }}
            >
              <span>Melete stops using this skill. Deleting it can’t be undone.</span>
              <span className="row" style={{ gap: 8 }}>
                <Button
                  size="sm"
                  variant="destructive"
                  loading={busy}
                  disabled={busy}
                  onClick={() => void onDelete().then((ok) => ok || setDeleting(false))}
                >
                  Delete it
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>
                  Keep it
                </Button>
              </span>
            </div>
          ) : null}
        </div>
        {editing || deleting ? null : (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <Button
              size="sm"
              variant="outline"
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              aria-label={`${open ? 'Hide' : 'Show'} the steps of ${skill.name}`}
              onClick={() => setOpen(!open)}
            >
              {open ? 'Hide steps' : 'Show steps'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Edit: ${skill.name}`}
              onClick={startEditing}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Delete: ${skill.name}`}
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function OwnSkills() {
  const loaded = useLoad(loadOwnSkills, []);
  const [busy, setBusy] = useState<string | null>(null);
  const data = loaded.data;
  const failed = (r: { error: string | null; unavailable: string | null }, fallback: string) => {
    toast({ kind: 'err', title: r.error ?? r.unavailable ?? fallback });
    // A skill that changed since it was shown is shown again as it is now.
    loaded.reload();
    return false;
  };
  const save = async (
    skill: OwnSkill,
    change: { description: string; triggers: string[]; body: string },
  ) => {
    if (!data || busy) return false;
    setBusy(skill.name);
    try {
      const r = await adapter.editOwnSkill(skill.name, {
        space_id: data.space,
        version: skill.version,
        ...change,
      });
      if (r.data === null) return failed(r, 'Couldn’t save your changes');
      const next = r.data.skill;
      loaded.set({ ...data, skills: data.skills.map((s) => (s.name === next.name ? next : s)) });
      toast({
        kind: 'ok',
        title: `Saved “${skill.name}”`,
        sub: 'Melete uses your words from now on.',
      });
      return true;
    } finally {
      setBusy(null);
    }
  };
  const remove = async (skill: OwnSkill) => {
    if (!data || busy) return false;
    setBusy(skill.name);
    try {
      const r = await adapter.deleteOwnSkill(skill.name, data.space, skill.version);
      if (r.data === null) return failed(r, 'Couldn’t delete it');
      loaded.set({ ...data, skills: data.skills.filter((s) => s.name !== skill.name) });
      toast({ kind: 'ok', title: `Deleted “${skill.name}”` });
      return true;
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="col" style={{ gap: 12, marginTop: 12 }} aria-labelledby="own-skills">
      <div className="col" style={{ gap: 4 }}>
        <h3
          id="own-skills"
          style={{
            fontFamily: 'var(--font-head)',
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--heading)',
          }}
        >
          Your skills
        </h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
          Skills you asked Melete to make. Read one whole, change its words, or delete it.
        </p>
      </div>
      {loaded.error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{loaded.error}</p> : null}
      {loaded.unavailable ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>{loaded.unavailable}</p>
      ) : null}
      {data ? (
        <div className="card-12" style={{ overflow: 'hidden' }}>
          <div style={{ height: 1 }} />
          {data.skills.map((skill) => (
            <OwnSkillRow
              key={`${skill.name}:${skill.version}`}
              skill={skill}
              busy={busy === skill.name}
              onSave={(change) => save(skill, change)}
              onDelete={() => remove(skill)}
            />
          ))}
          {data.skills.length === 0 ? (
            <div
              className="col"
              style={{ alignItems: 'center', gap: 8, padding: '32px 24px', textAlign: 'center' }}
            >
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                No skills yet. Ask Melete to “make a skill” for something you do often.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
