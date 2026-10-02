# Apps

Ask your agent for a dashboard, a tracker or a small form, and it can build one and publish it as
an app: a page you and the people you choose open from Melete.

## What an app is

An app is a folder of web files the agent wrote in its workspace: an `index.html` at the top, with
the scripts, styles, fonts and images it uses beside it. Everything is bundled. An app loads
nothing from other sites.

- Allowed files: html, js, mjs, css, json, svg, png, jpg, jpeg, gif, webp, ico, woff2, txt, map
  and wasm. The type each file is served as comes from its extension.
- At most 200 files, 25 MiB together, and 8 MiB for any one file.
- A folder that breaks a rule is refused before you are asked, with the list of what to fix.

## Publishing asks first

Publishing makes the app something other people can open, so the agent asks you every time,
including for each new version. The question shows:

- the app's name, how many files it has and how large they are. A new version names the app by
  the name it has now, and a new name is shown as a change of its own;
- who will be able to open it: only you, the people named by the email of their account here, or
  everyone with an account here;
- the data it shows, with the file and the conversation it comes from, and whether viewers see
  each new version at once or only after you review it. An app shows data only from your own
  conversations in the space it is published from;
- the responses it collects, if any.

Nothing is stored and nobody sees anything until you allow it. If a file changes after you allowed
it, that publish stops, and the agent asks again with the files as they are now.

Viewers need an account on this installation. There are no public links.

## Data that stays current

An app can show the newest version of a file in the workspace, such as `data/deals.json`. The
agent names the file when it publishes, and you see it on the question. A routine that rewrites
the file keeps the app current without a new version.

- The file is one the agent saved as a checked file (`files.write` with `expect`), so every
  version of it is recorded with the hash of its bytes. Viewers get exactly a recorded version.
- JSON is given to the app parsed, and other text (txt, csv, tsv, md) as a string, up to 2 MiB.
- An app reads only files from conversations in the space it was published from.
- An open app is told when data it read has a newer version, and reads it again if it wants.

### Reviewing updates first

By default, viewers see each new version as soon as it is written. The question to publish can
instead say that you review each one first. Then:

- viewers see nothing until you let a first version through, and after that, the version you let
  through last;
- the app's page tells you when a new version waits, and Review shows what it changes: for JSON,
  the top-level keys added, changed and removed, and the size before and after;
- "Show to viewers" lets the newest version through. An older one cannot be, so what viewers get
  is what you were shown. The version you let through is kept, so it stays the same when the
  file moves on.

The publisher, while they belong to the space, and the space's owner review updates.

## Responses

An app can collect responses, such as a form's answers, in collections it names when it is
published. A response is stored with the account of the person who sent it and the version they
sent it from.

- A response is a JSON object of at most the size its collection declares, and 16 KiB at most.
- One person can send one app 30 responses a minute, and an app keeps 10,000 at most. Past
  either, new ones are refused until a minute passes or a manager deletes some.
- Managers read responses under Responses on the app's page, and can delete one. Deleting removes
  what it said.
- An app's code can send a response in the name of the person viewing it without them pressing
  anything, within those limits. Responses say what the app sent, not what the person meant.

### The agent and responses

The agent can list the apps in its space that the person manages (`apps.list`) and read their
responses (`apps.read_submissions`), only in the space the app was published from. A response
is what a viewer, or the app's code, wrote: the agent treats it as data to summarise, never as
instructions, and anything it does about one asks as it always would.

## Versions

Every publish is a version. Each version names every file by its hash, so what people open is
exactly what was published. The app shows one version at a time:

- From the Apps screen, a manager can choose any earlier version. It takes effect at once.
- The agent can ask to go back to an earlier version with `apps.rollback`. That asks you first,
  and the question shows the data that version shows and who can open the app now.

## Who can open an app

The person who published an app manages it while they belong to the space it was published
from. The owner of that space manages it too. Either of them can make other people managers.

- Managers see every version and what changed between them, and the list of who can open the app.
- Managers can change who can open the app. People removed from the list lose the app on its
  next file request, and its open page closes within a minute. Who manages it is changed only
  by its publisher or the space's owner.
- A new version that sets who can open the app changes the viewers and keeps the managers.
- The publisher or the space's owner can delete an app. Its files are kept for a grace period while
  nothing else uses them, and then removed.

Removing a space removes its apps, with their versions, grants and files.

## Opening an app

Apps are listed on the Apps screen. Opening one shows it inside Melete, under a
header that names it, who published it, its version and when it changed.
Managers also see Versions, with "Use this version" for each earlier one,
Share, for who can open it, and Delete. The address of an app, `#/apps/<id>`,
stays the same across versions, so it can be shared with the people who can
open it.

### How an app is kept apart

An app runs in a frame with a separate, opaque origin. It cannot read Melete's
cookies, storage or API. Its scripts, styles, images and fonts load only from
its own files; its requests, forms, popups and frames to other sites are
blocked, and it cannot move the page it is shown in, or its own frame, to
another site.

**An app's code can still send data elsewhere over WebRTC.** Browsers today
let any page, sandboxed or not, open WebRTC connections to a server it names,
and no header stops them. A hostile app can use that to send what it shows, or
what a viewer types into it, to another server. Publish only apps whose code
you trust with the data they show. When the code uses WebRTC by name, the
question to publish says so; code that hides it is not found.

- Its files are served with `Content-Security-Policy: sandbox allow-scripts
  allow-forms allow-downloads` and a policy that allows only its own files. A
  response without that policy is never served.
- A view belongs to the browser session that opened it. It ends when that
  session signs out, after twelve hours at most, and whenever who can open the
  app, or the version it shows, changes. Each of these is checked on every file
  the app loads.
- The Apps screen checks the view every minute, and whenever the app asks
  Melete for something that fails. A person removed from an app loses it on its
  next file request, and the open page closes within a minute. What that page
  already loaded stays on their screen until then.
- A file opened on its own, outside Melete's frame, is refused.
- Apps open over https, or on this computer through `localhost`. Over plain
  http to another address, browsers do not say how a file is being loaded, so
  every app file is refused.

### What an app can ask Melete for

An app asks the page around it with `postMessage`, and Melete answers with
only what it fetched for the person viewing:

| Message | What happens |
|---|---|
| `{type:'melete.data', id, name}` | The data named `name`, as the publish approval listed it: parsed JSON, a string, or `null` before there is a version to show |
| `{type:'melete.submit', id, collection, record}` | Sends a response, for a collection the app declares |
| `{type:'melete.link', url}` | Asks the person, then opens an https link in a new tab |
| `{type:'melete.size', height}` | Sets the frame's height, within limits |

Answers come back as `{type:'melete.reply', id, ok, value}` or
`{type:'melete.reply', id, ok:false, error}`. Melete also sends
`{type:'melete.changed', name}` when data the app read has a newer version. A
small client an app can include:

```js
const melete = (() => {
  let next = 0;
  const waiting = new Map();
  addEventListener('message', (event) => {
    const reply = event.data;
    if (event.source !== parent || !reply || reply.type !== 'melete.reply') return;
    const settle = waiting.get(reply.id);
    if (!settle) return;
    waiting.delete(reply.id);
    reply.ok ? settle[0](reply.value) : settle[1](new Error(reply.error));
  });
  const changed = new Set();
  addEventListener('message', (event) => {
    if (event.source === parent && event.data && event.data.type === 'melete.changed')
      for (const listener of changed) listener(event.data.name);
  });
  const ask = (message) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, [resolve, reject]);
    parent.postMessage({ ...message, id }, '*');
  });
  return {
    data: (name) => ask({ type: 'melete.data', name }),
    submit: (collection, record) => ask({ type: 'melete.submit', collection, record }),
    onChange: (listener) => changed.add(listener),
    link: (url) => parent.postMessage({ type: 'melete.link', url }, '*'),
    size: (height) => parent.postMessage({ type: 'melete.size', height }, '*'),
  };
})();
```

## API

| Route | What it does |
|---|---|
| `GET /apps` | The apps you can open, with whether you manage each |
| `GET /apps/{id}` | One app: its files and data, and for managers its versions and grants |
| `POST /apps/{id}/current` | Choose the version people see (managers) |
| `PUT /apps/{id}/grants` | Replace who can open the app (managers) |
| `DELETE /apps/{id}` | Delete the app (its publisher or the space's owner) |
| `POST /apps/{id}/views` | A view of the app's current version for the person asking |
| `GET /apps/view/{token}/{path}` | One file of a view, isolated; no session is read |
| `GET /apps/{id}/data/{name}` | One of the app's data, for the person viewing it |
| `GET /apps/{id}/data-updates` | New data versions waiting for review (publisher or space owner) |
| `POST /apps/{id}/data-updates` | Let the newest version of reviewed data through to viewers |
| `POST /apps/{id}/submissions` | Send a response from the app |
| `GET /apps/{id}/submissions` | The app's responses, newest first (managers) |
| `DELETE /apps/{id}/submissions/{submission_id}` | Delete one response (managers) |

The agent's tools are on the built-in Apps connection, which every space has. `apps.publish` and
`apps.rollback` are `write_external` and always ask. `apps.list` and `apps.read_submissions`
only read.
