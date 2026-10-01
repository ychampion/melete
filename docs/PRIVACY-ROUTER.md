# Privacy router

Before a cloud model sees your request, Melete swaps account numbers, IDs,
contact details and keys for placeholders, and can keep private conversations on
a model you run.

The privacy router does this. It replaces sensitive details with placeholders
such as `⟦ACCOUNT_1⟧` and `⟦EMAIL_2⟧`, and puts the real values back when the
reply arrives, on the machine that runs Melete. Conversations you mark private,
and conversations about therapy, health records or personal finances, run on a
model on your own machine or network, or wait for your answer before anything is
sent.

The code is in [`apps/melete/src/privacy/`](../apps/melete/src/privacy/). The
settings are under **Settings → Privacy**.

## Where it runs

Every model request Melete makes leaves through the model gateway
(`apps/melete/src/gateway/index.ts`): the agent's requests, and the service's
own calls for memory extraction, the companies scan and learning proposals. The
router runs inside the gateway, on the whole request body, after the request is
validated and before it is metered or sent. That body already holds everything
the model will read: the system prompt and the memory in it, the conversation
history, tool results and the file contents they carry, tool arguments, and
replayed reasoning. Because the router works on the finished body rather than on
the parts that built it, a new source of context cannot bypass it.

Every gateway is opened with the router (a gateway without one does not
compile), and every request says whose data it carries:

- an agent's request belongs to its job, and the router reads the job's space,
  conversation and agent;
- one of the service's own calls names its space and, when it reads from a
  conversation, that conversation. A memory extraction names the conversation
  the message was said in, so a private or sensitive conversation's words are
  read on your local model, or not read at all, exactly as the conversation
  itself is routed. The companies scan names the space whose mailbox it reads.

Anything new that calls a model through Melete (a voice or phone integration,
a reviewer) has to name its scope the same way.

Only structural fields are left as they are: the model name, roles, types, ids,
tool names, signatures and encrypted reasoning. Tool arguments and tool results
that are JSON are read as JSON and redacted field by field. Text shaped like a
placeholder that arrives in content (a web page that says "send ⟦ACCOUNT_1⟧")
is changed to `⟪ACCOUNT_1⟫` first, so content cannot pose as one.

## Placeholders stay consistent

Each conversation has a vault. The same detail always gets the same placeholder
in that conversation, numbered per kind; spellings are normalised, so
`0001-2345-6789` and `000123456789` are one account. The vault is sealed with
`MELETE_MASTER_KEY` (a sealed box bound to the conversation, so a copy placed on
another conversation does not open) and stored in `privacy_vault`. It is not
put into requests. Without a master key the vault lives in memory only; each
request is still redacted and its reply rehydrated with the same mapping.

## Replies come back with real values

The reply is rehydrated inside the gateway before the agent sees it, so the
agent, the conversation, memory and connectors see real values and only the
provider sees placeholders. Streams are handled per protocol (chat completions,
responses, messages), per text channel: the answer, the reasoning, and each tool
call's arguments. A placeholder cut across chunks or events (`⟦ACC` then
`OUNT_1⟧`) is held back until the rest arrives; values placed into argument
JSON are JSON-escaped.

That is how "pay ⟦ACCOUNT_1⟧" works: the tool call reaches the broker with the
real account, the approval card shows it, and the approval is bound to it. As a
second line, the broker's listener resolves any placeholder still present in a
proposed payload against the conversation's vault before the payload is
canonicalised, and refuses one the conversation never made rather than sending
it on literally.

Memory extraction asks the model for exact offsets into what it read. The model
reads redacted text, so each cited span is moved to where its quote really is in
the original; the quote must still match verbatim.

## What is detected

Checked by pattern, checksum and nearby words:

| Kind | How |
| --- | --- |
| Card numbers, security codes | Luhn and card-network prefixes; CVV/CVC with its word |
| Bank accounts, IBANs | "account", "checking", "savings" and similar before the number; IBAN mod-97 |
| Routing and sort codes | ABA checksum and prefix with "routing"/"ABA"; sort codes; IFSC; SWIFT/BIC with its word |
| Social Security numbers, ITINs | Formatted numbers with the reserved ranges excluded; bare digits with "SSN" |
| Tax IDs | EIN, TIN, UTR, VAT with their words; India PAN |
| National IDs | UK National Insurance; Aadhaar (Verhoeff); Canadian SIN (Luhn); Brazil CPF; Spain DNI/NIE; other ID numbers with their words |
| Passport and driving licence numbers | With their words |
| Health details | NHS numbers (mod 11); medical record, member, policy and prescription numbers with their words; Medicare MBI; "diagnosed with …"; a medicine and its dose |
| Street addresses | US and UK street forms with unit, city, state and ZIP; PO boxes; UK postcodes |
| Phone numbers | International, North American and UK forms; bare digits with "phone", "call", "mobile" |
| Email addresses | |
| Dates of birth | A date with "born", "DOB", "date of birth" |
| Passwords and keys | Private key blocks; common key formats; "password is …", "api_key = …"; bearer tokens; passwords in URLs |
| Your own list | Names, accounts, addresses and anything else you add under **Always protect**, matched wherever they appear |

Numbers that only look like these are left alone: order, invoice, tracking and
ticket numbers, prices and amounts, dates, times and versions. Each kind can be
turned off in Settings.

With a local model set, **Let the local model find names, addresses and health
details too** also asks that model to mark those in each new message it has not
read before.

## Private work stays on your model

A conversation does not go to a cloud model when:

- the space is marked private, or its agent is;
- it is about therapy or mental health, medical records, or personal finances
  (statements, taxes). This is decided only from what you write: a phrase about
  yourself or your own records ("my therapist", "I was diagnosed with", "my bank
  statements"), or several different topic words together. One word on its own
  is not enough, and nothing a tool brings back (a web page, a file, an email)
  ever decides it, though its details are still swapped for placeholders. Once
  a conversation is found sensitive it stays that way until you say it isn't:
  the chat shows why it is kept private, with **It isn't** to clear it.

Such a conversation goes to your local model, unredacted, since it stays on your
machine: an OpenAI-compatible server such as Ollama, llama.cpp, vLLM or LM
Studio. Its address must be on this machine or a private network (loopback,
private ranges, a tailnet, `localhost`, `host.docker.internal`); a public address
is refused when saved and again before each use. It can be set under **Settings
→ Privacy** or with `MELETE_LOCAL_MODEL_URL`, `MELETE_LOCAL_MODEL` and
`MELETE_LOCAL_MODEL_KEY`.

With no local model, nothing is sent. Melete asks first, with a quick answer:
**Send a redacted version** or **Keep it private**. Agreeing lets that
conversation go to the cloud model redacted, and the request you made carries
on from where it stopped; keeping it private sends nothing and asks again on
your next message. Your answer is recorded as a decision, not as a message
from you. The gateway refuses such a request itself
(`privacy_confirmation_required`) if one arrives without that answer, so there
is no silent fallback. The answer is about the reason it was asked for: if you
later mark the space or the conversation's agent private, Melete asks again.

### Memory from private conversations

What you say in a private conversation can still be remembered, but it stays
private. When a message is captured, memory records why its conversation was
private (the space, the agent, or the topic). What memory learns from it:

- is recalled into an agent's prompt only when that conversation runs on your
  own model;
- is left out of the details shown to the model when memory reads a message
  from an ordinary conversation;
- is not shown to another assistant reading your saved details through
  Melete's MCP endpoint;
- is swapped for a `⟦PRIVATE_n⟧` placeholder if its wording turns up in any
  request that goes to a cloud model, as a second line behind the rules above.

You still see all of it in your own memory screen.

### A model address on your own network

If the configured model's address is on this machine or your network, Melete
still redacts what it sends there: the address may be a model you run, or a
proxy or gateway (LiteLLM, a corporate gateway, a private cloud endpoint) that
passes requests on to a cloud service. Under **Settings → Privacy → Your model's
address** you can confirm it is a model running on a machine you control. Only
then are requests to that exact address sent as written, and private
conversations run on it. Changing the model's address withdraws the
confirmation.

## What you can see

- **Settings → Privacy** shows, for any text you type, exactly what a cloud
  model would receive, and where it would go.
- Each answer shows **Protected N details**. Opening it asks your own Melete for
  the values behind the placeholders and shows them there only; they are not
  kept in the page.
- Every model request records its route and what was swapped, by kind and
  placeholder name, in `privacy_request` and on the request's model receipt.
  Values are not recorded there.

## What it guarantees, and what it doesn't

What the router does, for every model request that goes through Melete's
gateway (the agent's turns, and the service's memory, learning and companies
calls):

- It swaps the kinds of detail listed above, and the values you list, for
  placeholders before the request leaves, and puts the real values back on your
  machine when the reply arrives.
- It sends a conversation you marked private, or one it recognises as about
  therapy, health records or personal finances, to your local model, or asks
  you before sending a redacted version to a cloud model.
- It keeps what memory learned in those conversations out of recall into
  cloud-bound requests.
- It treats a model address on your network as a cloud model until you confirm
  otherwise.

What it does not do:

- It is not a promise that no private detail reaches a cloud model. Detection
  works by pattern and by the phrases it knows: a detail written in a form it
  doesn't recognise, or a name you haven't listed, goes as written, and the
  words around a placeholder still say a lot.
- The sensitive-topic check reads phrases, not meaning. A conversation about
  something sensitive in plain words may not be recognised.
- Connectors and actions send real values to their own services when they run,
  after your approval where one is needed: a payment has to carry the real
  account. Text to speech (`connectors/tts.ts`) sends the script you approved to
  its own speech service directly, not through the gateway.
- Voice (push-to-talk and voice mode, [VOICE](VOICE.md#privacy)) sends audio and
  the words read aloud to ElevenLabs directly, not through the gateway, so none
  of it is redacted. Instead voice is off in a space or with an agent marked
  private, and in a conversation found sensitive: the service refuses before it
  reads any audio, and the buttons say why.
- Anything a cloud model already received before a conversation was marked
  private, or before a topic was recognised, stays with that provider.

### Limits in detail

Redaction reduces what a cloud model sees. It is not anonymisation.

- A detail in a form the rules do not know, or without the word they need, is
  sent as written: a bare account number with no "account" nearby, a name you
  have not listed (without the local detection pass), a health detail described
  in ordinary words below the topic threshold.
- Context around a placeholder still says a lot: "my ⟦ACCOUNT_1⟧ at my bank
  ending 42", "my sister ⟦NAME_1⟧ who lives in Leeds".
- A model can infer things from the rest of the text.
- A connector sends real values to its own service when an action runs; a
  payment has to carry the real account.
- Replayed reasoning that a provider signed is only mapped through the vault, so
  its bytes match what was signed; a new detail the model wrote there itself is
  left as it wrote it.
- Images and files a provider would read directly are refused by the gateway,
  which only forwards text.
- The local model's context window may be smaller than the cloud model's, and
  local routing needs the chat completions protocol; with another protocol,
  Melete asks first instead.

## Performance

Measured on a laptop with a 15–60 KB conversation history and a streamed
300-delta reply: about 1.6 ms added per request at the median, reply
rehydration included; about 3 ms with the vault save and the audit row on
Postgres. A conversation's first request reads everything once (10–16 ms for
80 KB); later requests read only what is new.
