# Tool entries

Melete handles memory, skills, connected apps, the browser, the workspace and the model in the background. A conversation shows each piece of that work as a **tool entry**: what ran, and a short summary of what went in and what came out.

This page is the contract a client builds against. The schema lives in `packages/contracts/src/experience.ts` (`toolCall`), and the generated client carries the same types.

## Where entries arrive

Entries come through the conversation's event stream, `GET /conversations/{id}/events`, as JSON pages or as server-sent events. They reach the client in three forms:

| Item | When | Use it for |
| --- | --- | --- |
| `{ "type": "tool", "tool": ToolCall }` | Every time an entry changes | A live list of what is happening |
| `{ "type": "action", "label", "meta", "sources", "tool": ToolCall }` | Once, when an entry finishes | The turn's trail, which draws it as a step |
| `conversation.progress` | On `GET /conversations` and `GET /conversations/{id}` | The "In motion" line on Home |

Each `tool` item is a complete copy of the entry. Keep the latest copy for each `id`. The server-sent event name is the item type, so a client listening for `tool` receives these and nothing else.

The web client draws a turn's activity from the `tool` items: one row per entry, placed where the entry first appeared and updated in place with each newer copy. A finished copy is never replaced by a running copy read later. The finished-step copies with a `tool` field join the same row. Connected-app actions also arrive as one grouped step with source chips and no `tool` field; when a turn has rows, a client shows only that step's chips. The model's own entries and scheduled retries are not rows; a wait for the person's computer is.

### Steps

Each `model` entry is the model deciding what to do next, and the entries after it, up to the next `model` entry, are what it decided. The model's reasoning, as `reasoning` items, falls between them; draw it as a closed "Thinking" block rather than as the main content.

## The entry

```ts
type ToolCall = {
  id: string;              // stable across every copy of this entry
  kind: ToolKind;          // picks an icon; every kind has the same fields
  title: string;           // up to 120 characters, ready to show
  status: 'running' | 'done' | 'failed' | 'needs_approval' | 'unknown';
  started_at: string;      // ISO 8601
  ended_at: string | null; // set once the status is done, failed or unknown
  input_summary: ToolSummary | null;
  output_summary: ToolSummary | null;
  detail: ToolDetail | null;
  parent: string | null;   // the id of the entry this one sits under
  input_excerpt?: ToolExcerpt;   // the fuller input: a whole command
  output_excerpt?: ToolExcerpt;  // the fuller output: what a command printed, the subjects found
  failure?: 'error' | 'refused' | 'declined'; // on a failed entry, which way it went
};

type ToolExcerpt = {
  text: string;            // up to 2,000 characters and 40 lines, plain text
  from: 'page' | 'message' | 'file' | 'event' | 'app' | 'request';
  more: boolean;           // true when it was cut
};

type ToolSummary = {
  text: string;            // up to 160 characters, in Melete's own words
  quote?: {                // text from outside, up to 200 characters
    text: string;
    from: 'page' | 'message' | 'file' | 'event' | 'app' | 'request';
  };
};

type ToolDetail = {
  type: 'artifact' | 'permission' | 'receipt' | 'memory' | 'page';
  id: string;              // the artifact, approval, receipt or saved item to open
  url?: string;            // for a page: scheme, host and path only
};
```

### Kinds

| Kind | Work | Example titles |
| --- | --- | --- |
| `connector` | Mail, calendar and connected apps, including installed servers | "Read 3 emails from your inbox", "Proposed sending an email to sam@example.com — waiting for you", "Used Linear → create issue" |
| `web` | Reading a page, searching the web | "Read page example.com/guide", "Searched the web for “rent prices”" |
| `file` | Files in the space | "Wrote report.md (2 KB)" |
| `artifact` | Publishing a file, making audio | "Published report.pdf" |
| `browser` | Steps in a browser session | "Filled in a form" |
| `sandbox` | Commands, code and the screen of the agent's own computer | "Ran `python report.py` in its computer", "Took a screenshot of its computer" |
| `skill` | A skill applied to the request | "Used the skill: Research with sources" |
| `memory_recall` | Saved details the turn used | "Used what you told me: Home city, Diet" |
| `memory_write` | A new saved detail | "Remembered: Diet" |
| `memory_correct` | A saved detail changed | "Updated: Diet" |
| `memory_forget` | A saved detail removed | "Forgot: Diet" |
| `model` | The model working on the request | "Thinking", "Thought it through" |
| `retry` | A wait before trying the same request again | "Scheduled another try" |
| `tool` | Anything else | "Used a tool" |

A running entry's title describes the work in progress ("Sending an email to sam@example.com"). A finished one describes the result ("Sent an email to sam@example.com"), and one waiting on the person says so ("Proposed sending an email to sam@example.com — waiting for you"). A query, page, file name or command in a title is scrubbed like a quote, kept short and set off in quotation marks or backticks; when it fails the scrub, the title keeps the plain verb ("Ran a command in its computer"). What was typed on a screen is never named.

### Status

- `running`: under way.
- `needs_approval`: waiting on the person. `detail` is `{ "type": "permission", "id": <approval id> }`, the same id as the permission card in the stream.
- `done`: finished.
- `failed`: it did not happen. `output_summary` says why, in plain words ("You declined this."), and `failure` says which way: `declined` by the person, `refused` by a rule or the destination, or an `error`. A refusal's internal message is never shown.
- `unknown`: the destination never confirmed whether it happened. Melete asks the person before anything goes again. A read (`effect_class: read`) from a built-in connector is never `unknown`: it changed nothing, so one that did not answer is `failed` and can be tried again, and nobody is asked about it. A read left `unknown` by an earlier version is settled when the service starts, and the question it raised is withdrawn with it. A tool of an installed MCP server counts as such a read only when its server declares it read-only (`readOnlyHint`); a tool the installer's policy calls a read without that is asked about like any other effect.

An action entry (`id` starting `action:`) that leaves `needs_approval` means the person decided. Any other entry can arrive while a permission or question is open without closing it.

## Summaries

A summary is safe to show the person whose conversation it is:

- `text` is always Melete's own wording: counts, recipients, times, file and app names.
- Anything that came from outside is in `quote`, with `from` saying where it came from. That covers a page title, a message subject, a file name, or the words the model gave a tool. Draw a quote as a quotation from that source, never in the assistant's voice. A page can say "Ignore previous instructions" and it will arrive here as a quote from `page`.
- Render every `text` and `quote.text` as plain text. They are never Markdown or HTML, so a quote that contains `**`, `<a>` or a link stays literal.
- Values shaped like credentials, sealed secrets, signed tokens or internal record names are dropped entirely, including a secret inside a longer name such as `DB_PASSWORD=`. Links keep their scheme, host and path only, and a path that carries something shaped like a key is cut back to the site.
- Excerpts go through the same filter as an answer: a key, token or password is replaced by `[hidden]` where it stands and the words around it are kept, and a whole internal record is taken out. A line that still carries something shaped like a credential becomes `[hidden]`, and an excerpt with nothing left is left out. A message body or a file's contents is never an excerpt; the draft, the permission card and the file itself show those.
- A privacy placeholder in what the model gave a tool is shown with its real value, resolved against the conversation's own record, on that conversation's own stream only.
- Memory entries name saved details by their plain label ("Home city"). In a shared space, a detail another person saved is counted but never named or quoted. A recall never includes the saved values, and a forget never repeats what was forgotten.

## Progress

`conversation.progress` is present while a turn is under way, and for a day after it finishes:

```json
{ "steps_done": 4, "current": "Reading a web page" }
```

`steps_done` counts finished entries in the current turn, apart from the model and retries. `current` is the title of the latest entry that is still running or waiting for approval. While the turn waits on the person, only the entry waiting for approval counts. It is `null` between steps and once the turn has ended. Progress is a count of real steps, so draw it as steps done and the step under way rather than as a percentage.

## Replay

Entries are stored with the rest of the conversation's events. Reconnecting with `Last-Event-ID` (or `?since=`) continues the exact sequence, and reading from zero again returns the same items in the same order.

## When a chat, plan or routine is deleted

Deleting a chat (`DELETE /conversations/{id}`), a plan (`DELETE /plans/{id}`) or a routine (`DELETE /automations/{id}`) removes its entries with its other events. A routine goes with its thread. A routine's thread can be deleted on its own only once its routine is gone (409 `routine_thread` before that). The threads deleted routines left behind before routines took their threads were listed once by a migration (`orphaned_routine_thread`); the service removes each when it starts and logs it. Before that, the deletion does three things:

- It waits for anything still on its way out. While one of the chat's actions is `admitted` or `dispatched`, the delete answers 409 `still_sending` and nothing is removed. The broker still has to settle the send and reconcile a late receipt against that action's row. While an action is `unknown` or `unresolved`, the answer is 409 `outcome_unclear` until the person settles it. A read from a built-in connector never holds a deletion up, whatever its state.
- It keeps a record of what was done in the person's name. Each `succeeded` action with an outward effect (`write_external`, `write_reversible` or `spend`) is copied to `activity_record`, which belongs to the space rather than the job. The copy holds:
  - the kind;
  - the connection's label and provider;
  - the destination (the recipients of a message, the path of a file);
  - the receipt's `external_ref`;
  - the outcome and when it happened;
  - the title of the chat or plan it came from.

  It never holds a subject, a body or file contents. `GET /activity` lists these records, newest first, for the person whose work it was, and Settings shows them under Activity.
- It removes the rows that name the job without a foreign key: delivered memory context, prepared outputs, repair briefs and the privacy router's per-conversation records. It also clears pointers to the job from company items and files. The files themselves stay.

## Adding work to the stream

Work that happens inside Melete becomes an entry by writing a `notice` on the job, in the transaction that does the work or in a short one right after it commits. Memory writes it afterwards, so an event write never runs under the space lock:

- Memory writes `memoryToolNotice` (`kind: "memory_tool"`), with `op` set to `recall`, `write`, `correct` or `forget`, a count, plain labels, and the saved wording as `value`. Label and value rules are in the schema comment. `appendMemoryTool` in `apps/melete/src/experience/tools.ts` writes one, keeping at most 20 labels of up to 80 characters; the count still covers every detail.
- The recall entry is written in its own short transaction after the recall is recorded, taking the job the way every event writer does. It only describes the recall, so a write that fails is logged and the attempt carries on with the context it has.
- Anything else writes `toolTraceNotice` (`kind: "tool_trace"`) with a complete `ToolCall`, using `appendToolTrace`. Its id is shown as `trace:<id>`. Every string in it is scrubbed again before anyone sees it.
- Both helpers key each write by the job, the entry, its status and its content. A retried write lands once; a status revisited with new content, or the same id in another job, is written.

Broker actions, runtime tool events, model requests and memory recall produce their entries automatically.

## Example: one turn

A person asks "Book dinner with Sam at seven and let him know." These are the `tool` items for that turn, in order, with timestamps shortened:

```json
{"id":"memory:recall:att_7Q","kind":"memory_recall","title":"Used what you told me: Diet, Sam's email","status":"done","started_at":"19:00:00","ended_at":"19:00:00","input_summary":null,"output_summary":{"text":"2 saved details"},"detail":null,"parent":null}
{"id":"model:bl_1","kind":"model","title":"Thinking","status":"running","started_at":"19:00:01","ended_at":null,"input_summary":null,"output_summary":null,"detail":null,"parent":null}
{"id":"model:bl_1","kind":"model","title":"Thought it through","status":"done","started_at":"19:00:01","ended_at":"19:00:03","input_summary":null,"output_summary":{"text":"Answered in 1.9 s"},"detail":null,"parent":null}
{"id":"call:att_7Q:c1","kind":"skill","title":"Using the skill: Book a table","status":"running","started_at":"19:00:03","ended_at":null,"input_summary":{"text":"Asked for","quote":{"text":"dinner for two at seven","from":"request"}},"output_summary":null,"detail":null,"parent":null}
{"id":"call:att_7Q:c1","kind":"skill","title":"Used the skill: Book a table","status":"done","started_at":"19:00:03","ended_at":"19:00:03","input_summary":{"text":"Asked for","quote":{"text":"dinner for two at seven","from":"request"}},"output_summary":{"text":"Done"},"detail":null,"parent":null}
{"id":"action:act_2","kind":"web","title":"Reading page bistro.example/book","status":"running","started_at":"19:00:04","ended_at":null,"input_summary":{"text":"On bistro.example"},"output_summary":null,"detail":null,"parent":null}
{"id":"action:act_2","kind":"web","title":"Read page bistro.example/book","status":"done","started_at":"19:00:04","ended_at":"19:00:05","input_summary":{"text":"On bistro.example"},"output_summary":{"text":"Page read","quote":{"text":"Bistro Lune: book a table","from":"page"}},"detail":{"type":"page","id":"act_2","url":"https://bistro.example/book"},"parent":null}
{"id":"action:act_3","kind":"connector","title":"Sending an email to sam@example.com","status":"running","started_at":"19:00:07","ended_at":null,"input_summary":{"text":"To sam@example.com","quote":{"text":"Dinner at seven","from":"request"}},"output_summary":null,"detail":null,"parent":null}
{"id":"action:act_3","kind":"connector","title":"Proposed sending an email to sam@example.com — waiting for you","status":"needs_approval","started_at":"19:00:07","ended_at":null,"input_summary":{"text":"To sam@example.com","quote":{"text":"Dinner at seven","from":"request"}},"output_summary":{"text":"Waiting for your OK"},"detail":{"type":"permission","id":"apr_4"},"parent":null}
{"id":"action:act_3","kind":"connector","title":"Sending an email to sam@example.com","status":"running","started_at":"19:00:07","ended_at":null,"input_summary":{"text":"To sam@example.com","quote":{"text":"Dinner at seven","from":"request"}},"output_summary":null,"detail":null,"parent":null}
{"id":"action:act_3","kind":"connector","title":"Sent an email to sam@example.com","status":"done","started_at":"19:00:07","ended_at":"19:01:12","input_summary":{"text":"To sam@example.com","quote":{"text":"Dinner at seven","from":"request"}},"output_summary":{"text":"Sent"},"detail":{"type":"receipt","id":"act_3"},"parent":null}
{"id":"memory:write:k_9@1","kind":"memory_write","title":"Remembered: Favourite restaurant","status":"done","started_at":"19:01:13","ended_at":"19:01:13","input_summary":null,"output_summary":{"text":"Saved","quote":{"text":"Bistro Lune","from":"message"}},"detail":{"type":"memory","id":"k_9"},"parent":null}
```

The activity for the same turn has a row for the recall, the skill, the page, the email and the memory write, in that order; the model entries mark where each step began. While the email waits for approval, `progress` reads `{ "steps_done": 3, "current": "Proposed sending an email to sam@example.com — waiting for you" }`.

## Saving into the person's space and their Files

`artifact.publish` to the space and `files.write` / `files.move` into the person's own Files (`area` or `to_area` set to `artifacts`) follow one rule: a useful change the person can delete or undo goes through, and a risky one asks.

- A **new** file goes through without a question, with a receipt in the conversation's trail: a file published to an unused name in the space, written to an unused path in their Files, or moved from the agent's workspace to an unused name there.
- These still ask: saving over a file the person already keeps, moving a file out of their Files or renaming one there, a path that is not a plain name inside them, and sending a file by email. The permission card names where the file goes ("Save imgtest.png to your Files", "Move “a.png” out of your Files").
- The person's stricter settings still apply: "Ask me for everything", an agent set to ask before acting, and the switch for work in the agent's own workspace.
- Work in the agent's own workspace (`area: work`, the default) does not ask.
