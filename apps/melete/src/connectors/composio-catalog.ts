/**
 * The apps a person can connect through Composio: a short list of popular
 * ones shown on the connect screen, and a search over everything Composio
 * offers. An app is offered when Composio signs in to it with its own OAuth
 * app, or when the operator set an auth config of their own for it.
 *
 * Gmail, Google Calendar and Google Drive are not here: they are the parts of
 * the Google sign-in, read by Melete's own mail, calendar and Drive code. Nor
 * is an app the remote MCP catalog already connects (Notion, Linear, Jira,
 * GitHub, ...): its own server's entry is the one offered, so each app shows
 * once. A connection already made through Composio for one keeps working.
 */
import { mcpCatalogCovers } from '@melete/contracts';
import {
  COMPOSIO_OWN_TOOLKIT,
  type ComposioClient,
  type ComposioToolkitInfo,
  TOOLKIT_SLUG,
} from './composio.ts';

export type ComposioApp = {
  toolkit: string;
  title: string;
  description: string;
  logo: string | null;
  categories: string[];
};

/** The toolkits the Google sign-in connects, never offered as apps of their own. */
const GOOGLE_PARTS = new Set(['gmail', 'googlecalendar', 'googledrive']);

/**
 * Whether a toolkit is never offered as an app here, whatever Composio says
 * of it: one of Google's parts, Composio's own, or an app the remote MCP
 * catalog already offers.
 */
export const notOfferedHere = (toolkit: string): boolean =>
  !TOOLKIT_SLUG.test(toolkit) ||
  GOOGLE_PARTS.has(toolkit) ||
  COMPOSIO_OWN_TOOLKIT.test(toolkit) ||
  mcpCatalogCovers(toolkit);

/**
 * The popular apps, each one Composio signs in to with its own OAuth app,
 * less any the remote MCP catalog offers itself.
 */
export const POPULAR_APPS: ReadonlyArray<Omit<ComposioApp, 'logo' | 'categories'>> = [
  { toolkit: 'slack', title: 'Slack', description: 'Read and send messages in your workspace.' },
  { toolkit: 'notion', title: 'Notion', description: 'Search, read and edit pages and databases.' },
  { toolkit: 'github', title: 'GitHub', description: 'Issues, pull requests and repositories.' },
  { toolkit: 'linear', title: 'Linear', description: 'Issues, projects and cycles.' },
  { toolkit: 'googledocs', title: 'Google Docs', description: 'Read, write and edit documents.' },
  {
    toolkit: 'googlesheets',
    title: 'Google Sheets',
    description: 'Read and update spreadsheets.',
  },
  { toolkit: 'outlook', title: 'Outlook', description: 'Mail, calendar and contacts in Outlook.' },
  {
    toolkit: 'microsoft_teams',
    title: 'Microsoft Teams',
    description: 'Chats, channels and meetings.',
  },
  { toolkit: 'jira', title: 'Jira', description: 'Issues, boards and sprints.' },
  { toolkit: 'asana', title: 'Asana', description: 'Tasks, projects and teams.' },
  { toolkit: 'trello', title: 'Trello', description: 'Boards, lists and cards.' },
  { toolkit: 'clickup', title: 'ClickUp', description: 'Tasks, lists and docs.' },
  { toolkit: 'todoist', title: 'Todoist', description: 'Tasks and projects.' },
  { toolkit: 'airtable', title: 'Airtable', description: 'Bases, tables and records.' },
  { toolkit: 'hubspot', title: 'HubSpot', description: 'Contacts, companies and deals.' },
  {
    toolkit: 'salesforce',
    title: 'Salesforce',
    description: 'Accounts, contacts and opportunities.',
  },
  { toolkit: 'stripe', title: 'Stripe', description: 'Customers, payments and invoices.' },
  { toolkit: 'dropbox', title: 'Dropbox', description: 'Files and folders.' },
  { toolkit: 'zoom', title: 'Zoom', description: 'Meetings and recordings.' },
  { toolkit: 'calendly', title: 'Calendly', description: 'Event types and scheduled meetings.' },
  { toolkit: 'figma', title: 'Figma', description: 'Files, comments and projects.' },
  { toolkit: 'discord', title: 'Discord', description: 'Servers, channels and messages.' },
  { toolkit: 'linkedin', title: 'LinkedIn', description: 'Your profile and posts.' },
  { toolkit: 'youtube', title: 'YouTube', description: 'Videos, playlists and channels.' },
].filter((app) => !notOfferedHere(app.toolkit));

const SEARCH_MS = 10 * 60_000;
const MAX_KEPT = 200;
const QUERY = /^[\p{L}\p{N} ._-]{1,60}$/u;

export class ComposioCatalog {
  private readonly kept = new Map<string, { at: number; apps: Promise<ComposioToolkitInfo[]> }>();

  constructor(
    private readonly client: ComposioClient,
    /** Toolkits the operator set an auth config of their own for. */
    private readonly configured: ReadonlySet<string> = new Set(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether an app found at Composio can be signed in to here. */
  private offered(info: ComposioToolkitInfo): boolean {
    return (
      !notOfferedHere(info.slug) &&
      !info.noAuth &&
      (info.managedAuth || this.configured.has(info.slug))
    );
  }

  /** Composio's answer for a search, kept for a while and shared by everyone asking. */
  private find(search: string): Promise<ComposioToolkitInfo[]> {
    const key = search.toLowerCase();
    const at = this.now();
    const hit = this.kept.get(key);
    if (hit && at - hit.at < SEARCH_MS) return hit.apps;
    const apps = this.client.toolkits({ search: key, limit: 30 }).then((page) => page.items);
    apps.catch(() => this.kept.delete(key));
    if (this.kept.size >= MAX_KEPT) {
      const oldest = this.kept.keys().next().value;
      if (oldest !== undefined) this.kept.delete(oldest);
    }
    this.kept.set(key, { at, apps });
    return apps;
  }

  /** Apps matching `query` that can be connected here; an unusable query finds nothing. */
  async search(query: string): Promise<ComposioApp[]> {
    const search = query.trim();
    if (!QUERY.test(search)) return [];
    const found = await this.find(search);
    return found.filter((info) => this.offered(info)).map(appOf);
  }

  /** An app's name when it can be connected here, or null. */
  async title(toolkit: string): Promise<string | null> {
    if (notOfferedHere(toolkit)) return null;
    const popular = POPULAR_APPS.find((app) => app.toolkit === toolkit);
    if (popular) return popular.title;
    const found = await this.find(toolkit.replace(/_/g, ' '));
    const exact = found.find((info) => info.slug === toolkit);
    if (exact && this.offered(exact)) return exact.name.slice(0, 80) || toolkit;
    // Searched by the slug as written, in case its name reads otherwise.
    if (!exact && toolkit.includes('_')) {
      const again = (await this.find(toolkit)).find((info) => info.slug === toolkit);
      if (again && this.offered(again)) return again.name.slice(0, 80) || toolkit;
    }
    return null;
  }
}

function appOf(info: ComposioToolkitInfo): ComposioApp {
  return {
    toolkit: info.slug,
    title: info.name.slice(0, 80) || info.slug,
    description: info.description.slice(0, 300),
    logo: info.logo && /^https:\/\//.test(info.logo) ? info.logo : null,
    categories: info.categories.slice(0, 5),
  };
}

/** `toolkit=ac_id,...` as the operator wrote it, by toolkit. */
export function authConfigsSetting(value: string | undefined): Map<string, string> {
  const configs = new Map<string, string>();
  for (const pair of value?.split(',') ?? []) {
    const [toolkit, id] = pair.split('=');
    if (toolkit && id) configs.set(toolkit, id);
  }
  return configs;
}
