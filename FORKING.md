# Building on Melete

You can build your own product or setup on Melete and keep up with its releases:
run the published images as they are, and add what is yours beside them. This
page covers where your own pieces go and what Melete gives you to plug them in.

## Run the images, add your services beside them

Melete ships as Docker images (`melete-service`, `melete-web`, `melete-runtime`)
and a Compose stack in `deploy/`. Run those images unchanged, and add your own
services, a reverse proxy, or changed settings in Compose files of your own.

List them in `deploy/melete.deploy.json`:

```json
{
  "contract": 1,
  "compose_files": ["../private/compose.extra.yml", "docker-compose.brand.yml"]
}
```

- Paths are relative to `deploy/`, with `/` between folders.
- Every `melete` command reads them after Melete's own files, in the order
  listed, so a later file can add a service or change one of Melete's settings.
- Each file must exist. A missing one makes the contract invalid: `deploy` and
  `upgrade` refuse to run, and `status`, `doctor` and `check` say which file it
  is. When all are there, those three list them.

[The deploy file](docs/DEPLOYMENT.md#the-deploy-file) describes every key.

## Your name, logo and colours

Give the installation and its assistant their own names in `deploy/.env`:

```bash
bun run melete set MELETE_INSTANCE_NAME='Riverside Assistant' MELETE_ASSISTANT_NAME=Juniper
```

The instance name is the page title, the home-screen title, and the name in
sign-in and password reset mail. The assistant name is the name the assistant
uses for itself. `MELETE_IDENTITY_FILE` replaces the assistant's whole identity
with a short file of your own.

For icons, a logo and colours, add `docker-compose.brand.yml` to
`compose_files` and put your files in `deploy/brand` (or the folder
`MELETE_BRAND_SOURCE` names):

```
brand/
  favicon.svg
  icons/apple-touch-icon.png
  logo.png
  manifest.webmanifest
  brand.css
```

`brand.css` sets the design tokens from
[`apps/web/src/design/tokens.css`](apps/web/src/design/tokens.css): surfaces,
text, accent, corners, shadows and fonts. Those token names are the contract
between your colours and the app. [Names and look](docs/DEPLOYMENT.md#names-and-look)
lists the files the folder may hold, the rule sets `brand.css` may use, and every
token. Some words in the app still say Melete; showing your name there too is
planned.

## Configure with the environment

Everything the service reads comes from `deploy/.env`, checked once at start,
so a wrong value is a clear message when the stack starts. `deploy/.env.example`
describes each setting, and `bun run melete set NAME=value` changes one in place
and says which services to recreate. A name Melete does not read is refused,
with the closest one it does.

## Extension points

These are on `main` today:

- **The HTTP API.** Every capability the web client has, a script has too. The
  OpenAPI document is `packages/contracts/openapi.json`, and `@melete/client` is
  a typed client generated from it ([Building a client](docs/CLIENT.md)).
- **Melete as an MCP server.** Other assistants can act for one person through
  Melete, with that person's consent ([MCP server](docs/MCP-SERVER.md)).
- **Connectors.** Melete reaches other services through connectors, remote and
  local MCP servers among them, each with the scopes and effect classes the
  installation declares ([Connectors](docs/CONNECTORS.md)).
- **Skills.** A skill in a person's space replaces the built-in one of the same
  name.
- **Notifications for whoever runs the installation.** Alerts
  ([Alerts](docs/DEPLOYMENT.md#alerts)), problem reports
  ([Problem reports](docs/FEEDBACK.md)) and the health detail behind
  `MELETE_OPERATOR_TOKEN`.

An API for managing people and their limits from your own tools is planned.

## Where your code goes

Keep your own code in `private/` at the top of your checkout, or in a separate
repository, and reach Melete through the points above. Leave `apps/` and
`packages/` as they are released: then each release applies cleanly, and what
you run is the release plus your own files.

If Melete needs a hook it does not have yet, open an issue or a pull request
for it here, so it becomes part of a release you can follow.

## Following releases

- Pin the images to a release with `MELETE_IMAGE_TAG` (for example `v0.3.0`)
  rather than following `main`.
- Read [UPGRADING.md](docs/UPGRADING.md) and the
  [changelog](CHANGELOG.md) entry before you move to a new release.
  `bun run melete upgrade <tag>` reads your `compose_files` along with
  Melete's own.
- A release that renames a design token or a setting says so in its upgrade
  notes.

## License duties

Melete is licensed under the Apache License 2.0.

- Keep `LICENSE` and `NOTICE` in what you distribute, including the third-party
  notices `NOTICE` carries, and add your own notices beside them.
- Say which files you changed, as the license asks.
- The license grants no rights to the Melete name or logo. A product you build
  on Melete goes by its own name, which is what `MELETE_INSTANCE_NAME`, the
  assistant name and the brand folder are for. "Built on Melete" is a fine way
  to say where it comes from.
