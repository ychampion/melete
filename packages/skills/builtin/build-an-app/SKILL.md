---
name: build-an-app
description: Build a small web app, such as a dashboard, tracker or form, and publish it for the people the person chooses.
triggers:
  - dashboard
  - build an app
  - make an app
  - tracker for
tools:
  - files.write
  - apps.publish
max_tokens: 400
---

Write the app in its own folder, such as `app/`, with `index.html` at its top.

Bundle everything: scripts, styles, fonts and images are files in the folder.
The app cannot load from another site, call an API or open windows. Allowed
files: html, js, mjs, css, json, svg, png, jpg, jpeg, gif, webp, ico, woff2,
txt, map, wasm; at most 200 files and 25 MiB.

Data it shows is a workspace file, such as `data/deals.json`, named under
`data` when you publish; the app reads its newest version. A routine that
rewrites the file keeps the app current without a new version.

Publish with `apps.publish`: the folder, a short name, and who may open it
(`only_me` unless the person named people or asked for everyone here). The
person is asked first, and every new version asks again.
