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
- the data it shows, with the file and the conversation it comes from. An app shows data only
  from your own conversations in the space it is published from;
- the forms it collects answers with, if any.

Nothing is stored and nobody sees anything until you allow it. If a file changes after you allowed
it, that publish stops, and the agent asks again with the files as they are now.

Viewers need an account on this installation. There are no public links.

## Data that stays current

An app can show the newest version of a file in the workspace, such as `data/deals.json`. The
agent names the file when it publishes, and you see it on the question. A routine that rewrites
the file keeps the app current without a new version.

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
- Managers can change who can open the app. People removed from the list lose the app straight
  away. Who manages it is changed only by its publisher or the space's owner.
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
cookies, storage or API, and it cannot fetch anything, load from other sites,
open windows or move the page it is shown in. It loads only its own files.

- Its files are served with `Content-Security-Policy: sandbox allow-scripts
  allow-forms allow-downloads` and a policy that allows only its own files. A
  response without that policy is never served.
- Each view lasts 15 minutes and is renewed while the app is open. Changing
  who can open the app, or which version it shows, ends every open view at
  once, and the person removed loses it straight away.
- A file opened on its own, outside Melete's frame, is refused.

### What an app can ask Melete for

An app asks the page around it with `postMessage`, and Melete answers with
only what it fetched for the person viewing:

| Message | What happens |
|---|---|
| `{type:'melete.data', id, name}` | The data named `name`, as the publish approval listed it |
| `{type:'melete.link', url}` | Asks the person, then opens an https link in a new tab |
| `{type:'melete.size', height}` | Sets the frame's height, within limits |

Answers come back as `{type:'melete.reply', id, ok, value}` or
`{type:'melete.reply', id, ok:false, error}`. A small client an app can
include:

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
  const ask = (message) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, [resolve, reject]);
    parent.postMessage({ ...message, id }, '*');
  });
  return {
    data: (name) => ask({ type: 'melete.data', name }),
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

The agent's tools are `apps.publish` and `apps.rollback` on the built-in Apps connection, which
every space has. Both are `write_external` and always ask.
