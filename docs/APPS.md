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

- the app's name, how many files it has and how large they are;
- who will be able to open it: only you, the people named by the email of their account here, or
  everyone with an account here;
- the data it shows, with the file and the conversation it comes from;
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
- The agent can ask to go back to an earlier version with `apps.rollback`. That asks you first.

## Who can open an app

The person who published an app manages it. They can also make other people managers.

- Managers see every version and what changed between them, and the list of who can open the app.
- Managers can replace that list. People removed from it lose the app straight away.
- Only the person who published an app can delete it. Its files are kept for a grace period while
  nothing else uses them, and then removed.

Removing a space removes its apps, with their versions, grants and files.

## API

| Route | What it does |
|---|---|
| `GET /apps` | The apps you can open, with whether you manage each |
| `GET /apps/{id}` | One app: its files and data, and for managers its versions and grants |
| `POST /apps/{id}/current` | Choose the version people see (managers) |
| `PUT /apps/{id}/grants` | Replace who can open the app (managers) |
| `DELETE /apps/{id}` | Delete the app (the person who published it) |

The agent's tools are `apps.publish` and `apps.rollback` on the built-in Apps connection, which
every space has. Both are `write_external` and always ask.
