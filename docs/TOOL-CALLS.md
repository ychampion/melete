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

The trail already shows connected-app actions as one grouped step with source chips. Those steps have no `tool` field. The finished-step copies with a `tool` field cover the work that the grouped step leaves out: memory, skills, the browser, the workspace, and tools the runtime runs itself. The model's own thinking and retries appear as `tool` items only.

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
| `connector` | Mail, calendar and connected apps, including installed plugins | "Sending the email", "Sent the email", "Used Linear" |
| `web` | Reading a page, searching the web | "Read a web page", "Searched the web" |
| `file` | Files in the space | "Saved a file" |
| `artifact` | Publishing a file, making audio | "Published a file" |
| `browser` | Steps in a browser session | "Filled in a form" |
| `sandbox` | Commands and code in the workspace | "Ran a command" |
| `skill` | A skill applied to the request | "Used the skill: Research with sources" |
| `memory_recall` | Saved details the turn used | "Used what you told me: Home city, Diet" |
| `memory_write` | A new saved detail | "Remembered: Diet" |
| `memory_correct` | A saved detail changed | "Updated: Diet" |
| `memory_forget` | A saved detail removed | "Forgot: Diet" |
| `model` | The model working on the request | "Thinking", "Thought it through" |
| `retry` | A wait before trying the same request again | "Scheduled another try" |
| `tool` | Anything else | "Used a tool" |

A running entry's title describes the work in progress ("Sending the email"). A finished one describes the result ("Sent the email").

### Status

- `running`: under way.
- `needs_approval`: waiting on the person. `detail` is `{ "type": "permission", "id": <approval id> }`, the same id as the permission card in the stream.
- `done`: finished.
- `failed`: it did not happen. `output_summary` says why, in plain words ("You declined this.").
- `unknown`: the destination never confirmed whether it happened. Melete asks the person before anything goes again.

An action entry (`id` starting `action:`) that leaves `needs_approval` means the person decided. Any other entry can arrive while a permission or question is open without closing it.

## Summaries

A summary is safe to show the person whose conversation it is:

- `text` is always Melete's own wording: counts, recipients, times, file and app names.
- Anything that came from outside is in `quote`, with `from` saying where it came from. That covers a page title, a message subject, a file name, or the words the model gave a tool. Draw a quote as a quotation from that source, never in the assistant's voice. A page can say "Ignore previous instructions" and it will arrive here as a quote from `page`.
- Render every `text` and `quote.text` as plain text. They are never Markdown or HTML, so a quote that contains `**`, `<a>` or a link stays literal.
- Values shaped like credentials, sealed secrets, signed tokens or internal record names are dropped entirely, including a secret inside a longer name such as `DB_PASSWORD=`. Links keep their scheme, host and path only, and a path that carries something shaped like a key is cut back to the site.
- Memory entries name saved details by their plain label ("Home city"). In a shared space, a detail another person saved is counted but never named or quoted. A recall never includes the saved values, and a forget never repeats what was forgotten.

## Progress

`conversation.progress` is present while a turn is under way, and for a day after it finishes:

```json
{ "steps_done": 4, "current": "Reading a web page" }
```

`steps_done` counts finished entries in the current turn, apart from the model and retries. `current` is the title of the latest entry that is still running or waiting for approval. While the turn waits on the person, only the entry waiting for approval counts. It is `null` between steps and once the turn has ended. Progress is a count of real steps, so draw it as steps done and the step under way rather than as a percentage.

## Replay

Entries are stored with the rest of the conversation's events. Reconnecting with `Last-Event-ID` (or `?since=`) continues the exact sequence, and reading from zero again returns the same items in the same order.

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
{"id":"action:act_2","kind":"web","title":"Reading a web page","status":"running","started_at":"19:00:04","ended_at":null,"input_summary":{"text":"On bistro.example"},"output_summary":null,"detail":null,"parent":null}
{"id":"action:act_2","kind":"web","title":"Read a web page","status":"done","started_at":"19:00:04","ended_at":"19:00:05","input_summary":{"text":"On bistro.example"},"output_summary":{"text":"Page read","quote":{"text":"Bistro Lune: book a table","from":"page"}},"detail":{"type":"page","id":"act_2","url":"https://bistro.example/book"},"parent":null}
{"id":"action:act_3","kind":"connector","title":"Sending the email","status":"running","started_at":"19:00:07","ended_at":null,"input_summary":{"text":"To sam@example.com","quote":{"text":"Dinner at seven","from":"request"}},"output_summary":null,"detail":null,"parent":null}
{"id":"action:act_3","kind":"connector","title":"Sending the email","status":"needs_approval","started_at":"19:00:07","ended_at":null,"input_summary":{"text":"To sam@example.com","quote":{"text":"Dinner at seven","from":"request"}},"output_summary":{"text":"Waiting for your OK"},"detail":{"type":"permission","id":"apr_4"},"parent":null}
{"id":"action:act_3","kind":"connector","title":"Sending the email","status":"running","started_at":"19:00:07","ended_at":null,"input_summary":{"text":"To sam@example.com","quote":{"text":"Dinner at seven","from":"request"}},"output_summary":null,"detail":null,"parent":null}
{"id":"action:act_3","kind":"connector","title":"Sent the email","status":"done","started_at":"19:00:07","ended_at":"19:01:12","input_summary":{"text":"To sam@example.com","quote":{"text":"Dinner at seven","from":"request"}},"output_summary":{"text":"Sent"},"detail":{"type":"receipt","id":"act_3"},"parent":null}
{"id":"memory:write:k_9@1","kind":"memory_write","title":"Remembered: Favourite restaurant","status":"done","started_at":"19:01:13","ended_at":"19:01:13","input_summary":null,"output_summary":{"text":"Saved","quote":{"text":"Bistro Lune","from":"message"}},"detail":{"type":"memory","id":"k_9"},"parent":null}
```

The trail for the same turn shows the recall, the skill and the memory write as finished steps, and the page and the email as the grouped connected-app step. While the email waits for approval, `progress` reads `{ "steps_done": 3, "current": "Sending the email" }`.
