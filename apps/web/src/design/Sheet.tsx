/**
 * The living component reference: every primitive in every state, rendered
 * from the same code the product uses. It replaces the canvas Components
 * artboard. Reach it at #/design.
 */
import { type ReactNode, useState } from 'react';
import { AgentFace, FACE_PALETTE, FACE_SHAPES, FACE_STATES, type FaceShape } from './face.tsx';
import { ICON_PATHS, Icon, type IconName } from './icons.tsx';
import { LOGOS, Logo, type LogoName } from './logos.tsx';
import { MeleteAvatar } from './mark.tsx';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Chip,
  Count,
  Dialog,
  Field,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuItem,
  MenuSep,
  Overline,
  Radio,
  Segmented,
  Select,
  Skeleton,
  TabsUnderline,
  Toast,
  Toggle,
} from './primitives.tsx';

export type SheetExtra = { title: string; body: ReactNode }[];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="col" style={{ gap: 14 }}>
      <Overline>{title}</Overline>
      {children}
    </section>
  );
}

function Wrap({ children, gap = 12 }: { children: ReactNode; gap?: number }) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap }}>
      {children}
    </div>
  );
}

function Lab({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="col" style={{ gap: 8, alignItems: 'flex-start' }}>
      {children}
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{text}</span>
    </div>
  );
}

const NOVA = { color: '#4aa3f7', eyes: 'white' as const, shape: 'blob' as const };

export function Sheet({ extra = [] }: { extra?: SheetExtra }) {
  const [checked, setChecked] = useState(true);
  const [toggled, setToggled] = useState(true);
  const [seg, setSeg] = useState<'table' | 'board'>('table');
  const [tab, setTab] = useState<'progress' | 'done'>('progress');
  const [dialog, setDialog] = useState(false);
  const [shape, setShape] = useState<FaceShape>('blob');
  const [select, setSelect] = useState('wellbeing');

  return (
    <div
      className="col"
      style={{
        gap: 40,
        padding: '32px 24px 80px',
        maxWidth: 1240,
        margin: '0 auto',
        width: '100%',
      }}
    >
      <div className="col" style={{ gap: 6 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.01em' }}>
          Melete components
        </h1>
        <p style={{ fontSize: 14, color: 'var(--muted)' }}>
          Every screen is built from these pieces. This page renders them from the product's own
          code.
        </p>
      </div>

      <Section title="Buttons · variants">
        <Wrap>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button variant="soft">Soft</Button>
        </Wrap>
      </Section>

      <Section title="Buttons · sizes and states">
        <Wrap>
          <Button size="sm">Small</Button>
          <Button size="md">Default</Button>
          <Button size="lg">Large</Button>
          <Button size="xl">Touch</Button>
          <IconButton name="plus" label="Add" size={36} iconSize={18} variant="outline" />
          <Button icon="calendar">With icon</Button>
          <Button variant="outline" iconRight="chevronDown">
            Menu
          </Button>
        </Wrap>
        <Wrap gap={20}>
          <Lab text="Default">
            <Button>Add to calendar</Button>
          </Lab>
          <Lab text="Disabled">
            <Button disabled>Add to calendar</Button>
          </Lab>
          <Lab text="Loading">
            <Button loading>Adding…</Button>
          </Lab>
          <Lab text="Ghost with icon">
            <Button variant="ghost" icon="pencil">
              Edit draft
            </Button>
          </Lab>
          <Lab text="Icon · on">
            <IconButton name="panelRight" label="Day panel" on />
          </Lab>
        </Wrap>
      </Section>

      <Section title="Inputs">
        <Wrap gap={20}>
          <Lab text="Default">
            <Input placeholder="Plan title" width={280} />
          </Lab>
          <Lab text="With value">
            <Input defaultValue="Run a 10K in November" width={280} />
          </Lab>
          <Lab text="Error">
            <div className="col" style={{ gap: 6 }}>
              <Input defaultValue="tonight at 25:00" error width={280} />
              <span className="row" style={{ gap: 4, fontSize: 12, color: 'var(--danger)' }}>
                <Icon name="alert" size={12} />
                Use a time between 00:00 and 23:59
              </span>
            </div>
          </Lab>
          <Lab text="Search with shortcut">
            <Input
              placeholder="Search your workspace"
              icon="search"
              width={280}
              trailing={<Kbd>⌘K</Kbd>}
            />
          </Lab>
          <Lab text="Select">
            <Select
              label="Category"
              value={select}
              onChange={setSelect}
              width={200}
              options={[
                { value: 'travel', label: 'Travel' },
                { value: 'wellbeing', label: 'Wellbeing' },
                { value: 'learning', label: 'Learning' },
              ]}
            />
          </Lab>
          <Lab text="Disabled">
            <Input placeholder="Plan title" disabled width={240} />
          </Lab>
        </Wrap>
      </Section>

      <Section title="Selection controls">
        <Wrap gap={28}>
          <Lab text="Checkbox">
            <span className="row" style={{ gap: 8 }}>
              <Checkbox checked={false} label="Unchecked" />
              <Checkbox checked={checked} onChange={setChecked} label="Checked" />
              <Checkbox checked disabled label="Disabled" />
              <Checkbox checked round label="Round" />
            </span>
          </Lab>
          <Lab text="Radio">
            <span className="row" style={{ gap: 8 }}>
              <Radio on={false} label="Off" />
              <Radio on label="On" />
            </span>
          </Lab>
          <Lab text="Switch">
            <span className="row" style={{ gap: 8 }}>
              <Toggle on={false} label="Off" />
              <Toggle on={toggled} onChange={setToggled} label="On" />
              <Toggle on disabled label="Disabled" />
            </span>
          </Lab>
        </Wrap>
      </Section>

      <Section title="Badges & chips">
        <Wrap gap={8}>
          <Badge tone="travel">Travel</Badge>
          <Badge tone="wellbeing">Wellbeing</Badge>
          <Badge tone="learning">Learning</Badge>
          <Badge tone="finance">Finances</Badge>
          <Badge>Neutral</Badge>
          <Badge tone="outline">Example</Badge>
          <Badge tone="success" dot>
            Connected
          </Badge>
          <Badge tone="danger" dot>
            Needs attention
          </Badge>
          <Badge tone="chip">Tonight, 7:30 PM</Badge>
          <Count n={3} />
        </Wrap>
        <Wrap gap={8}>
          <Chip on>All</Chip>
          <Chip>Travel</Chip>
          <Chip>Wellbeing</Chip>
          <Chip icon="calendar">Plan my day</Chip>
          <Kbd>⌘K</Kbd>
          <Kbd>Esc</Kbd>
        </Wrap>
      </Section>

      <Section title="Tabs & segmented">
        <Wrap gap={24}>
          <TabsUnderline
            label="Plans"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'progress', label: 'In progress', count: 4 },
              { value: 'done', label: 'Completed' },
            ]}
          />
          <Segmented
            label="View"
            value={seg}
            onChange={setSeg}
            options={[
              { value: 'table', label: 'Table' },
              { value: 'board', label: 'Board' },
            ]}
          />
        </Wrap>
      </Section>

      <Section title="Avatars and the mark">
        <Wrap>
          <Avatar initials="JD" size={24} />
          <Avatar initials="JD" size={32} />
          <Avatar initials="JD" size={40} />
          <Avatar initials="AC" tone="sage" />
          <Avatar initials="PS" tone="sand" />
          <MeleteAvatar size={28} />
          <MeleteAvatar size={36} />
        </Wrap>
      </Section>

      <Section title="Agent faces · nine states">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))',
            gap: 16,
            padding: 16,
            borderRadius: 14,
            background: 'var(--studio)',
          }}
        >
          {FACE_STATES.map(([key, label, sub]) => (
            <div key={key} className="col" style={{ gap: 8, alignItems: 'center' }}>
              <AgentFace look={NOVA} size={64} state={key} glow />
              <span style={{ fontSize: 12, fontWeight: 500, color: '#d3d5da' }}>{label}</span>
              <span style={{ fontSize: 11, color: '#8a8f98', marginTop: -6 }}>{sub}</span>
            </div>
          ))}
        </div>
        <Wrap gap={20}>
          {FACE_SHAPES.map(([key, label]) => (
            <Lab key={key} text={label}>
              <button type="button" onClick={() => setShape(key)} aria-label={`Preview ${label}`}>
                <AgentFace look={{ color: '#0f8f7a', eyes: 'white', shape: key }} size={56} />
              </button>
            </Lab>
          ))}
          <Lab text="White eyes">
            <AgentFace look={{ color: '#a43fc8', eyes: 'white', shape }} size={56} />
          </Lab>
          <Lab text="Black eyes">
            <AgentFace look={{ color: '#f4c430', eyes: 'black', shape }} size={56} />
          </Lab>
        </Wrap>
        <Wrap gap={6}>
          {FACE_PALETTE.map((color) => (
            <span
              key={color}
              style={{ width: 28, height: 28, borderRadius: 8, background: color }}
            />
          ))}
        </Wrap>
      </Section>

      <Section title="Menus and dialogs">
        <div className="row" style={{ gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Lab text="Recent chat · row">
            <Menu label="Chat">
              <MenuItem icon="pencil">Rename</MenuItem>
              <MenuItem icon="pin">Pin to top</MenuItem>
              <MenuItem icon="files" sub>
                Move to space
              </MenuItem>
              <MenuItem icon="share">Share chat</MenuItem>
              <MenuSep />
              <MenuItem icon="trash" danger>
                Delete
              </MenuItem>
            </Menu>
          </Lab>
          <Lab text="Account · spaces">
            <Menu label="Account" width={232}>
              <Overline style={{ padding: '6px 8px 2px' }}>Jamie Davis</Overline>
              <div style={{ padding: '0 8px 6px', fontSize: 12, color: 'var(--muted)' }}>
                jamie@example.com
              </div>
              <MenuSep />
              <MenuItem icon="user" on>
                Personal
              </MenuItem>
              <MenuItem icon="files">Work</MenuItem>
              <MenuSep />
              <MenuItem icon="sliders" kbd="⌘,">
                Settings
              </MenuItem>
              <MenuItem icon="logout" danger>
                Sign out
              </MenuItem>
            </Menu>
          </Lab>
          <Lab text="Dialog · keyboard-navigable">
            <Button variant="outline" onClick={() => setDialog(true)}>
              Open a dialog
            </Button>
          </Lab>
        </div>
        <Dialog
          open={dialog}
          onClose={() => setDialog(false)}
          title="Create a plan"
          sub="Melete will suggest milestones once you save."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(false)}>
                Cancel
              </Button>
              <Button onClick={() => setDialog(false)}>Create plan</Button>
            </>
          }
        >
          <Field label="Title">
            <Input defaultValue="Run a 10K in November" width="100%" />
          </Field>
          <Field label="Why it matters (optional)">
            <textarea className="textarea" placeholder="A sentence or two." />
          </Field>
        </Dialog>
      </Section>

      <Section title="Feedback">
        <div className="col" style={{ gap: 12 }}>
          <Toast
            kind="ok"
            title="Added to your calendar"
            sub="Dinner with Alex & Priya · Tonight 7:30 PM"
            action="Undo"
          />
          <Toast
            kind="err"
            title="Couldn’t reach Google Calendar"
            sub="Your event is saved locally and will sync when you’re back online."
            action="Retry"
          />
          <div className="col" style={{ gap: 8, width: 440, maxWidth: '100%' }}>
            <Skeleton width="60%" />
            <Skeleton width="40%" height={10} />
          </div>
        </div>
      </Section>

      {extra.map((section) => (
        <Section key={section.title} title={section.title}>
          {section.body}
        </Section>
      ))}

      <Section title="Logos · only where a person checks a connection or a source">
        <Wrap gap={10}>
          {(Object.keys(LOGOS) as LogoName[]).map((name) => (
            <Logo key={name} name={name} size={28} />
          ))}
        </Wrap>
      </Section>

      <Section title="Icons">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
            gap: 8,
          }}
        >
          {(Object.keys(ICON_PATHS) as IconName[]).map((name) => (
            <div
              key={name}
              className="col"
              style={{
                gap: 6,
                alignItems: 'center',
                padding: '10px 4px',
                borderRadius: 8,
                background: 'var(--surface)',
                border: '1px solid var(--line)',
              }}
            >
              <Icon name={name} size={18} />
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{name}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
