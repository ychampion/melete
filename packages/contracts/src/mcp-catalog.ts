/**
 * Apps whose makers run their own remote MCP server, offered as one click:
 * the person signs in to the app, and Melete installs the tools listed here.
 *
 * Each tool's effect is decided here, never by the server's annotations:
 *
 * - `read`: looks only. Runs without asking.
 * - `write_reversible`: a change that can be put back where it was made, such
 *   as editing a page or moving an issue to another state. It goes through
 *   auto-review like any other reversible change.
 * - `write_external`: posts or sends something as the person that other
 *   people see or are told about (a comment, a new issue, a pull request),
 *   merges, or deletes. It always asks first.
 * - `spend`: moves or commits money. It always asks first.
 *
 * Names a server does not list when someone connects are left out, and tools
 * a server lists that are not named here are never offered.
 */
import type { EffectClass } from './broker.ts';
import type { McpConnectionConfig } from './connections.ts';

export type McpCatalogTool = {
  /** The tool's name on the server. */
  name: string;
  /** Its grant is `mcp_<entry id>.<alias>`. */
  alias: string;
  /** What it does, in the person's words. */
  label: string;
  effect_class: EffectClass;
};

export type McpCatalogEntry = {
  id: string;
  title: string;
  /** What Melete can do with the app once it is connected, in plain words. */
  description: string;
  url: string;
  /** Something the person should know before connecting it. */
  warning?: string;
  /**
   * Set when the app's sign-in accepts only a client registered with it ahead
   * of time: the operator registers one and names it in these settings.
   */
  client?: { id_setting: string; secret_setting: string; register_at: string };
  tools: readonly McpCatalogTool[];
};

const tool =
  (effect_class: EffectClass) =>
  (name: string, alias: string, label: string): McpCatalogTool => ({
    name,
    alias,
    label,
    effect_class,
  });
const read = tool('read');
const change = tool('write_reversible');
const post = tool('write_external');
const spend = tool('spend');

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'notion',
    title: 'Notion',
    description:
      'Search your Notion workspace, read pages and databases, and write or tidy pages for you. Comments go out after you approve them.',
    url: 'https://mcp.notion.com/mcp',
    tools: [
      read('notion-search', 'search', 'Search your workspace'),
      read('notion-fetch', 'fetch', 'Read a page or database'),
      read('notion-get-comments', 'get_comments', 'Read comments on a page'),
      read('notion-get-users', 'get_users', 'See who is in the workspace'),
      read('notion-get-user', 'get_user', 'Look up a person in the workspace'),
      read('notion-get-self', 'get_self', 'See which account is connected'),
      read('notion-get-teams', 'get_teams', 'See the workspace’s teamspaces'),
      change('notion-create-pages', 'create_pages', 'Create pages'),
      change('notion-update-page', 'update_page', 'Edit a page'),
      change('notion-move-pages', 'move_pages', 'Move pages'),
      change('notion-duplicate-page', 'duplicate_page', 'Duplicate a page'),
      change('notion-create-database', 'create_database', 'Create a database'),
      change('notion-update-database', 'update_database', 'Change a database’s layout'),
      post('notion-create-comment', 'create_comment', 'Comment as you'),
    ],
  },
  {
    id: 'linear',
    title: 'Linear',
    description:
      'Find and read Linear issues, projects and documents, and keep issues up to date. New issues, projects and comments go out after you approve them.',
    url: 'https://mcp.linear.app/mcp',
    tools: [
      read('list_issues', 'list_issues', 'List issues'),
      read('get_issue', 'get_issue', 'Read an issue'),
      read('list_comments', 'list_comments', 'Read comments on an issue'),
      read('list_projects', 'list_projects', 'List projects'),
      read('get_project', 'get_project', 'Read a project'),
      read('list_teams', 'list_teams', 'List teams'),
      read('get_team', 'get_team', 'Read a team'),
      read('list_users', 'list_users', 'List people'),
      read('get_user', 'get_user', 'Look up a person'),
      read('list_issue_statuses', 'list_issue_statuses', 'List issue states'),
      read('get_issue_status', 'get_issue_status', 'Read an issue state'),
      read('list_issue_labels', 'list_issue_labels', 'List labels'),
      read('list_project_labels', 'list_project_labels', 'List project labels'),
      read('list_cycles', 'list_cycles', 'List cycles'),
      read('list_documents', 'list_documents', 'List documents'),
      read('get_document', 'get_document', 'Read a document'),
      read('search_documentation', 'search_documentation', 'Search Linear’s help'),
      change('update_issue', 'update_issue', 'Change an issue'),
      change('update_project', 'update_project', 'Change a project'),
      change('create_issue_label', 'create_issue_label', 'Add a label'),
      post('create_issue', 'create_issue', 'Open an issue as you'),
      post('create_project', 'create_project', 'Start a project as you'),
      post('create_comment', 'create_comment', 'Comment as you'),
    ],
  },
  {
    id: 'atlassian',
    title: 'Atlassian',
    description:
      'Search Jira and Confluence, read issues and pages, and keep issues and pages up to date. New issues, pages and comments go out after you approve them.',
    url: 'https://mcp.atlassian.com/v2/mcp',
    tools: [
      read('atlassianUserInfo', 'user_info', 'See which account is connected'),
      read('getAccessibleAtlassianResources', 'list_sites', 'List your Atlassian sites'),
      read('search', 'search', 'Search Jira and Confluence'),
      read('fetch', 'fetch', 'Read an issue or page'),
      read('getJiraIssue', 'get_jira_issue', 'Read a Jira issue'),
      read('searchJiraIssuesUsingJql', 'search_jira_issues', 'Search Jira issues'),
      read('getVisibleJiraProjects', 'list_jira_projects', 'List Jira projects'),
      read('getJiraProjectIssueTypesMetadata', 'jira_issue_types', 'List a project’s issue types'),
      read('getTransitionsForJiraIssue', 'jira_transitions', 'See where an issue can move'),
      read('lookupJiraAccountId', 'find_jira_person', 'Look up a person in Jira'),
      read('getJiraIssueRemoteIssueLinks', 'jira_issue_links', 'Read an issue’s links'),
      read('getConfluencePage', 'get_confluence_page', 'Read a Confluence page'),
      read('getConfluenceSpaces', 'list_confluence_spaces', 'List Confluence spaces'),
      read('getPagesInConfluenceSpace', 'list_confluence_pages', 'List pages in a space'),
      read('getConfluencePageDescendants', 'confluence_page_children', 'List a page’s subpages'),
      read('getConfluencePageFooterComments', 'confluence_comments', 'Read comments on a page'),
      read(
        'getConfluencePageInlineComments',
        'confluence_inline_comments',
        'Read inline comments on a page',
      ),
      read('searchConfluenceUsingCql', 'search_confluence', 'Search Confluence'),
      change('editJiraIssue', 'edit_jira_issue', 'Change a Jira issue'),
      change('transitionJiraIssue', 'move_jira_issue', 'Move a Jira issue to another state'),
      change('updateConfluencePage', 'update_confluence_page', 'Edit a Confluence page'),
      post('createJiraIssue', 'create_jira_issue', 'Open a Jira issue as you'),
      post('addCommentToJiraIssue', 'comment_jira_issue', 'Comment on a Jira issue as you'),
      post('addWorklogToJiraIssue', 'log_jira_work', 'Log time on a Jira issue as you'),
      post('createConfluencePage', 'create_confluence_page', 'Publish a Confluence page as you'),
      post('createConfluenceFooterComment', 'comment_confluence_page', 'Comment on a page as you'),
      post(
        'createConfluenceInlineComment',
        'inline_comment_confluence_page',
        'Comment inline on a page as you',
      ),
    ],
  },
  {
    id: 'sentry',
    title: 'Sentry',
    description:
      'Look into Sentry issues, errors, traces and releases, and resolve or assign issues. Anything that creates projects or starts an analysis asks you first.',
    url: 'https://mcp.sentry.dev/mcp',
    tools: [
      read('whoami', 'whoami', 'See which account is connected'),
      read('find_organizations', 'find_organizations', 'List organizations'),
      read('find_teams', 'find_teams', 'List teams'),
      read('find_projects', 'find_projects', 'List projects'),
      read('find_releases', 'find_releases', 'List releases'),
      read('find_dsns', 'find_dsns', 'List a project’s keys'),
      read('get_issue_details', 'get_issue_details', 'Read an issue'),
      read('get_trace_details', 'get_trace_details', 'Read a trace'),
      read('get_event_attachment', 'get_event_attachment', 'Read an event’s attachment'),
      read('search_events', 'search_events', 'Search events'),
      read('search_issues', 'search_issues', 'Search issues'),
      read('search_docs', 'search_docs', 'Search Sentry’s docs'),
      read('get_doc', 'get_doc', 'Read a Sentry doc'),
      change('update_issue', 'update_issue', 'Resolve or assign an issue'),
      change('update_project', 'update_project', 'Change a project’s settings'),
      post('analyze_issue_with_seer', 'analyze_issue', 'Start an AI analysis of an issue'),
      post('create_team', 'create_team', 'Create a team'),
      post('create_project', 'create_project', 'Create a project'),
      post('create_dsn', 'create_dsn', 'Create a project key'),
    ],
  },
  {
    id: 'stripe',
    title: 'Stripe',
    description:
      'Look up customers, payments, invoices and subscriptions in Stripe, and add customers and products. Anything that moves or asks for money waits for your approval.',
    url: 'https://mcp.stripe.com',
    warning:
      'Stripe can move money: refunds, invoices, payment links and subscription changes each wait for your approval.',
    tools: [
      read('get_stripe_account_info', 'account_info', 'See which account is connected'),
      read('retrieve_balance', 'balance', 'Read your balance'),
      read('list_customers', 'list_customers', 'List customers'),
      read('list_products', 'list_products', 'List products'),
      read('list_prices', 'list_prices', 'List prices'),
      read('list_invoices', 'list_invoices', 'List invoices'),
      read('list_payment_intents', 'list_payments', 'List payments'),
      read('list_subscriptions', 'list_subscriptions', 'List subscriptions'),
      read('list_coupons', 'list_coupons', 'List coupons'),
      read('list_disputes', 'list_disputes', 'List disputes'),
      read('search_stripe_resources', 'search', 'Search your Stripe data'),
      read('fetch_stripe_resources', 'fetch', 'Read a Stripe object'),
      read('search_stripe_documentation', 'search_docs', 'Search Stripe’s docs'),
      change('create_customer', 'create_customer', 'Add a customer'),
      change('create_product', 'create_product', 'Add a product'),
      change('create_price', 'create_price', 'Add a price'),
      spend('create_coupon', 'create_coupon', 'Create a coupon'),
      spend('create_payment_link', 'create_payment_link', 'Create a payment link'),
      spend('create_invoice', 'create_invoice', 'Draft an invoice'),
      spend('create_invoice_item', 'create_invoice_item', 'Add a line to an invoice'),
      spend('finalize_invoice', 'finalize_invoice', 'Finalize an invoice'),
      spend('create_refund', 'create_refund', 'Refund a payment'),
      spend('cancel_subscription', 'cancel_subscription', 'Cancel a subscription'),
      spend('update_subscription', 'update_subscription', 'Change a subscription'),
      spend('update_dispute', 'update_dispute', 'Answer a dispute'),
    ],
  },
  {
    id: 'github',
    title: 'GitHub',
    description:
      'Search and read your GitHub repositories, issues and pull requests. New issues, comments, pull requests, merges and commits go out after you approve them.',
    url: 'https://api.githubcopilot.com/mcp/',
    client: {
      id_setting: 'GITHUB_MCP_CLIENT_ID',
      secret_setting: 'GITHUB_MCP_CLIENT_SECRET',
      register_at: 'https://github.com/settings/applications/new',
    },
    tools: [
      read('get_me', 'get_me', 'See which account is connected'),
      read('search_repositories', 'search_repositories', 'Search repositories'),
      read('search_code', 'search_code', 'Search code'),
      read('search_issues', 'search_issues', 'Search issues'),
      read('search_pull_requests', 'search_pull_requests', 'Search pull requests'),
      read('search_users', 'search_users', 'Search people'),
      read('get_file_contents', 'get_file_contents', 'Read a file'),
      read('list_branches', 'list_branches', 'List branches'),
      read('list_commits', 'list_commits', 'List commits'),
      read('get_commit', 'get_commit', 'Read a commit'),
      read('list_tags', 'list_tags', 'List tags'),
      read('list_releases', 'list_releases', 'List releases'),
      read('get_latest_release', 'get_latest_release', 'Read the latest release'),
      read('list_issues', 'list_issues', 'List issues'),
      read('issue_read', 'issue_read', 'Read an issue'),
      read('get_issue', 'get_issue', 'Read an issue'),
      read('get_issue_comments', 'get_issue_comments', 'Read comments on an issue'),
      read('list_pull_requests', 'list_pull_requests', 'List pull requests'),
      read('pull_request_read', 'pull_request_read', 'Read a pull request'),
      read('get_pull_request', 'get_pull_request', 'Read a pull request'),
      read('get_pull_request_files', 'get_pull_request_files', 'List a pull request’s files'),
      read('get_pull_request_diff', 'get_pull_request_diff', 'Read a pull request’s changes'),
      read('get_pull_request_status', 'get_pull_request_status', 'Read a pull request’s checks'),
      change('update_issue', 'update_issue', 'Change an issue'),
      change('update_pull_request', 'update_pull_request', 'Change a pull request'),
      change('create_branch', 'create_branch', 'Create a branch'),
      post('issue_write', 'issue_write', 'Open or change an issue as you'),
      post('create_issue', 'create_issue', 'Open an issue as you'),
      post('add_issue_comment', 'add_issue_comment', 'Comment as you'),
      post('create_pull_request', 'create_pull_request', 'Open a pull request as you'),
      post('merge_pull_request', 'merge_pull_request', 'Merge a pull request'),
      post('create_or_update_file', 'create_or_update_file', 'Commit a file as you'),
      post('push_files', 'push_files', 'Push commits as you'),
      post('delete_file', 'delete_file', 'Delete a file'),
      post('create_repository', 'create_repository', 'Create a repository'),
      post('fork_repository', 'fork_repository', 'Fork a repository'),
    ],
  },
];

export const mcpCatalogEntry = (id: string): McpCatalogEntry | undefined =>
  MCP_CATALOG.find((entry) => entry.id === id);

/**
 * The installation an entry makes, for the tools named (all of them unless a
 * narrower list is given): one grant per tool, each its own and nothing more.
 */
export function mcpCatalogConfig(
  entry: McpCatalogEntry,
  url: string,
  tools: readonly McpCatalogTool[] = entry.tools,
): McpConnectionConfig {
  const scope = (item: McpCatalogTool) => `mcp_${entry.id}.${item.alias}`;
  return {
    id: entry.id,
    url,
    audience: 'owner',
    allowed_scopes: tools.map(scope),
    tools: tools.map((item) => ({
      name: item.name,
      alias: item.alias,
      required_scopes: [scope(item)],
      effect_class: item.effect_class,
    })),
  };
}

/** Whether a tool's effect means the person is asked before every use. */
export const asksFirst = (effect: EffectClass): boolean =>
  effect === 'write_external' || effect === 'spend';

/**
 * A tool a server listed when it was added by its address, as far as it
 * describes itself. Its own hints only suggest where it starts; the person
 * decides how far each tool may act before anything is installed.
 */
export type McpListedTool = {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

/** Names that only look: `get_issue`, `list-pages`, `searchDocs`, `read_wiki_contents`. */
const LOOKS =
  /^(get|list|search|find|fetch|read|query|lookup|describe|show|view|count|retrieve)(?:$|[_.-]|[A-Z])/;
/** Words for moving or committing money, anywhere in a name. */
const MONEY =
  /refund|payment|payout|charge|transfer|purchase|checkout|invoice|subscription|coupon|pay(?:$|[_.-]|[A-Z])/i;

/**
 * Where a listed tool starts: a read when it says it only reads or is named
 * like a lookup (unless it says it destroys), spending when its name is about
 * money, a change that can be undone when it says it destroys nothing, and
 * otherwise asking first.
 */
export function suggestedEffect(tool: McpListedTool): EffectClass {
  const hints = tool.annotations ?? {};
  const looks = hints.readOnlyHint === true || LOOKS.test(tool.name);
  if (looks && hints.destructiveHint !== true && hints.readOnlyHint !== false) return 'read';
  if (MONEY.test(tool.name)) return 'spend';
  if (hints.destructiveHint === false) return 'write_reversible';
  return 'write_external';
}

/** A short name for a tool: lower-case letters, digits and underscores, starting with a letter. */
export function mcpToolAlias(name: string): string {
  const plain = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72);
  return /^[a-z]/.test(plain) ? plain : `t_${plain || 'tool'}`;
}

/** A server's short name from what the person called it, as an MCP installation names it. */
export function mcpServerId(label: string): string {
  return mcpToolAlias(label).slice(0, 40).replace(/_+$/, '');
}

/** The most tools one server added by its address installs: one grant each. */
export const MAX_DISCOVERED_TOOLS = 64;

/**
 * The installation a server added by its address makes, for the tools the
 * person kept and how far each may act: one grant per tool, as the catalog's.
 */
export function mcpDiscoveredConfig(
  id: string,
  url: string,
  choices: readonly { name: string; effect_class: EffectClass }[],
): McpConnectionConfig {
  const taken = new Set<string>();
  const tools = choices.map((choice) => {
    const base = mcpToolAlias(choice.name);
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}_${n}`;
    taken.add(alias);
    return {
      name: choice.name,
      alias,
      required_scopes: [`mcp_${id}.${alias}`],
      effect_class: choice.effect_class,
    };
  });
  return {
    id,
    url,
    audience: 'owner',
    allowed_scopes: tools.flatMap((tool) => tool.required_scopes),
    tools,
  };
}
