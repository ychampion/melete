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

Write the app in its own folder, such as `app/`, with `index.html` on top.

Bundle everything: scripts, styles, fonts and images are files in the folder.
It cannot load from other sites, call APIs or open windows. Use web file
types (html, js, css, json, images, woff2); at most 200 files and 25 MiB.

Data it shows is a file saved with `files.write` and `expect`, such as
`data/deals.json`, named under `data` when you publish. To keep it current,
set `source` to a routine's id from `apps.routines`; each run updates it.

To read it, `parent.postMessage({type:'melete.data',id,name:'deals'},'*')`; the
answer is a `message` from `parent`: `{type:'melete.reply',id,ok,value}`.

Publish with `apps.publish`: the folder, a short name, and who may open it
(`only_me` unless the person named people or everyone here). It asks the
person only when it reaches new people, uses WebRTC or shows new data.
