# NVIDIA Nemotron on Nebius Token Factory

Run Melete with NVIDIA's open Nemotron models through
[Nebius Token Factory](https://tokenfactory.nebius.com). Connect a key in
Settings, or let the server environment supply it. Token Factory speaks the
OpenAI-compatible chat completions API at
`https://api.tokenfactory.nebius.com/v1/`, as shown in its
[quickstart](https://docs.tokenfactory.nebius.com/quickstart).

## Connect in the app

1. Create a Token Factory account and an API key.
2. Open **Settings → Models** and pick **Nebius Token Factory**.
3. Paste your key and choose **Test connection**. Melete fetches the provider's
   model list using that key.
4. Choose **NVIDIA Nemotron 3.5 Super VL** and select **Save and use**.

The key is stored encrypted on your server. The server needs `MELETE_MASTER_KEY`
to store keys entered in the app. If the operator already supplies a Nebius key,
Settings shows **Set by the operator**; test and choose a model with that key.
Changing the model takes effect on the next reply without a restart.

The picker recommends Super, Nano, Ultra and Super VL in that order. After a successful
test, it offers the models your provider actually returned, with available
recommendations first. **Type a model name instead** accepts an exact model ID
for another model your account can use.

## Choose a model

| Model | Exact Token Factory model ID | Context tokens | Tools | Reads images | Use it for |
| --- | --- | ---: | --- | --- | --- |
| NVIDIA Nemotron 3.5 Super VL | `nvidia/Nemotron-3.5-Super-VL` | 1,048,576 | Yes | Yes | The main model: everyday work, rooms, and the photos and scans people send |
| NVIDIA Nemotron 3 Super | `nvidia/nemotron-3-super-120b-a12b` | 262,144 | Yes | No | Text-only everyday work, coding and multi-step tasks |
| NVIDIA Nemotron 3 Nano | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 262,144 | Yes | No | Quick side calls, such as reading chats into memory and quick voice replies |
| NVIDIA Nemotron 3 Ultra | `nvidia/Nemotron-3-Ultra-550b-a55b` | 1,048,576 | Yes | No | Long research and demanding reasoning |

These are the public serverless recommendations. Exact IDs, tool support and
token limits come from the
[official model catalog](https://tokenfactory.nebius.com/model-catalog.md) and its
[model metadata](https://tokenfactory.nebius.com/api/public/models_info).
The [Nemotron models page](https://nebius.com/services/token-factory/models/nvidia-nemotron-models-inference)
lists the same limits. Context includes both input and output.

Make Nemotron 3.5 Super VL the primary model. Rooms read photos: someone takes
a picture of a letter, a bill or a form with their phone and posts it, and the
room's model reads it itself (see [Rooms](ROOMS.md#threads-and-asking-the-agent)).
Super VL reads pictures as well as text and video, and it calls tools and
reasons like Super, so one model covers the whole conversation. It is priced
like Super, at $0.30 per million input tokens, $0.06 cached and $0.90 output,
and its weights are released under OpenMDW-1.1.

In **Settings → Models → Secondary model**, use the same Nebius connection to
choose Nano, and keep **Quick side tasks** on **Secondary** for short calls such
as reading chats into memory. **Scheduled and repeating jobs** stay on the
primary unless you move them. For a long research session, switch the primary
to Ultra and return to Super VL afterwards.

Super, Nano and Ultra above read text only. Nemotron **Nano Omni needs a dedicated
endpoint** and is not a serverless preset. To use it, deploy it with Nebius and
connect its assigned URL, key and model ID through **OpenAI-compatible endpoint**
in Settings. An Omni or VL vision model can read images; leave **Send screenshots
as pictures** off for the three text-only recommendations.

## Notes for Nemotron

When the chosen model's ID contains `nemotron`, from any provider, Melete adds a
short set of notes to the end of the agent's instructions: give times in tool
arguments with the person's own UTC offset, search with a keyword or two at a time, read an
item before judging it, copy privacy placeholders exactly, follow through on an
approval in the same turn, say an action is done only when its result says so,
ask for a person's answer with the ask tool and keep a question for one person
visible to that person alone, and keep the final answer short, with no
reasoning in it. The notes are plain data in
`packages/contracts/src/model-guidance.ts`, one entry per model family, so they
can be edited there without touching any other code; a test keeps each entry
under 250 tokens.

### The guidance switch

`MELETE_MODEL_GUIDANCE` is on by default: leave it empty, or set anything but
`off`, and the notes are added. `MELETE_MODEL_GUIDANCE=off` leaves out the notes
and any chat template arguments below. The service reads it once, at start, so
change it in `deploy/.env` and recreate the service:

```bash
bun run deploy/scripts/set-env.ts MELETE_MODEL_GUIDANCE=off
docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete
```

### The thinking switch

Nemotron's reasoning stays at the provider's default. To switch it, set
`chat_template_kwargs` on the `nemotron` entry in
`packages/contracts/src/model-guidance.ts`. Melete then sends it with every chat
completions call to a Nemotron model:

- `{ enable_thinking: false }` turns reasoning off, for the quickest replies;
- `{ enable_thinking: true, low_effort: true }` keeps it on with shorter reasoning.

A request that already names its own `chat_template_kwargs` keeps them, and
`MELETE_MODEL_GUIDANCE=off` sends none.

## Configure from the environment

Give the Melete service these variables:

```dotenv
MELETE_DEFAULT_PROVIDER=nebius
MELETE_DEFAULT_MODEL=nvidia/Nemotron-3.5-Super-VL
NEBIUS_API_KEY=your-token-factory-key
```

An app selection takes precedence over the environment's default model. Choose
**Use the server default** in Settings to return to it. The environment's key
takes precedence over a key saved in the app.

The deployment configuration helper also accepts `--provider nebius --model`
with an exact ID. Read the key without displaying it, then clear it from the
shell after the helper writes `deploy/.env`:

```bash
read -rs NEBIUS_API_KEY && export NEBIUS_API_KEY
bun run deploy/scripts/configure.ts --provider nebius --model nvidia/Nemotron-3.5-Super-VL
unset NEBIUS_API_KEY
```

To turn on [rooms](ROOMS.md#turning-rooms-on) as well, set the preview flag
before you start the stack:

```bash
bun run deploy/scripts/set-env.ts MELETE_PREVIEW_MULTIPLAYER=true
```

### Pass the key to a Compose service

The shipped `deploy/docker-compose.yml` passes `NEBIUS_API_KEY` from
`deploy/.env` to the Melete service, as it does for the other provider keys.
Recreate the service after changing the key:

```bash
docker compose -f deploy/docker-compose.yml up -d --wait
```

Only the Melete service receives the provider key; the agent's computer receives
credentials from the gateway. See [Deployment → Providers](DEPLOYMENT.md#providers)
for the surrounding setup.

## Run the open weights yourself

Nemotron's weights are open, so the same models can run on your own hardware
through an OpenAI-compatible server such as
[vLLM](https://docs.vllm.ai/en/latest/serving/openai_compatible_server/).
Choose **OpenAI-compatible endpoint** in Settings, enter the server's version
prefix, test it and select the model ID that server exposes. For an environment
setup, use `MELETE_DEFAULT_PROVIDER=openai-compatible`, `OPENAI_COMPAT_BASE_URL`
and `OPENAI_COMPAT_API_KEY` with that server's model ID in `MELETE_DEFAULT_MODEL`.
A server that checks no key still needs a non-empty value in Melete.

The [compatible-provider instructions](DEPLOYMENT.md#providers) cover addresses
and keys. Use the context limit your server actually serves. If you also want
private conversations to use it, configure the local model in
**Settings → Privacy** as described in [Privacy router](PRIVACY-ROUTER.md).
