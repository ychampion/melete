# Voice

Melete can listen and speak. One ElevenLabs API key turns on four things:

| Feature | What it does |
| --- | --- |
| Speech (`audio.synthesize`) | Reads a script aloud and saves the audio as a WAV file in the space's finished work. |
| Transcription (`audio.transcribe`) | Turns an audio or video file from the space's files into a transcript, with each speaker labelled and timed, saved as Markdown in the space's finished work. |
| Push-to-talk | A microphone button in the chat's message box. Tap to record, tap again to stop. The words appear in the box for you to read, change and send. |
| Voice mode | A hands-free call in a chat. You talk, Melete answers out loud and keeps talking with you while it works, and you can talk over it to stop it. |

Without a key none of these appear, and nothing else changes.

## Set it up

1. Create an API key in your ElevenLabs account. Give it access to text to
   speech, speech to text and single-use tokens.
2. Put it in `deploy/.env`:

   ```bash
   ELEVENLABS_API_KEY=your-key
   ```

   Or export it before the first `configure.ts` run, which writes it for you:

   ```bash
   read -rs ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY
   bun run deploy/scripts/configure.ts
   unset ELEVENLABS_API_KEY
   ```

3. Recreate the service: `docker compose -f deploy/docker-compose.yml up -d melete`.

Every existing space gains a **Speech** and a **Transcription** connection at
the next start. Either can be removed in Settings like any other connection,
and a removed one is not added back.

The key stays in the service. The browser never receives it: voice mode is
given a single-use token that works once and expires after 15 minutes.

The microphone needs a secure page: `https://`, or `localhost` on the machine
itself. Over plain `http://` from another device, the browser refuses the
microphone and Melete says so.

## Settings

All optional. An empty value uses the default.

| Setting | Default | What it sets |
| --- | --- | --- |
| `ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` | The voice for speech and voice mode, from your ElevenLabs voice library. |
| `ELEVENLABS_SECOND_VOICE_ID` | the first voice | The second voice in a two-person script. |
| `ELEVENLABS_SPEECH_MODEL` | `eleven_multilingual_v2` | The model that makes speech files. |
| `ELEVENLABS_STREAMING_MODEL` | `eleven_flash_v2_5` | The model that reads replies in voice mode, chosen for low delay. |
| `ELEVENLABS_TRANSCRIPTION_MODEL` | `scribe_v2` | The model for transcription and push-to-talk. Voice mode listens with `scribe_v2_realtime`, the only realtime model. |
| `MELETE_VOICE_DAILY_SECONDS` | `1800` | Seconds of push-to-talk recording one person may have transcribed in a day. |
| `MELETE_VOICE_DAILY_CHARACTERS` | `20000` | Characters of replies one person may have read aloud in a day. |
| `MELETE_VOICE_DAILY_SESSIONS` | `30` | Voice mode conversations one person may start in a day. |

A day is the last 24 hours, counted per person across all their spaces. A
request the speech service refuses does not count; one that was sent and never
answered does, because the service may have done the work.

## What each feature does

### Speech and transcription

These are capabilities an agent uses while it works, for example to turn a
script into an episode or a recorded call into notes. Each one is a paid call,
so each asks for your approval first, with the exact file and settings shown,
and is held against the job's budget. The result is a file in the space's
finished work, and the receipt records its size and content hash.

Transcription reads files up to 100 MB in these formats: AAC, FLAC, M4A, MKV,
MOV, MP3, MP4, MPEG, OGG, Opus, WAV and WebM. The transcript starts a new
paragraph when the speaker changes, and after a minute of one speaker.

If an OpenAI key is set and no ElevenLabs key, speech uses OpenAI and there is
no transcription, push-to-talk or voice mode.

### Push-to-talk

- A recording can be up to 2 minutes. The recorder stops itself at 2 minutes.
- A recording can be up to 5 MB. Two minutes of speech is well under that.
- The words are never sent for you. They land in the message box, after
  anything already typed there.
- The recording is not kept. It is passed to ElevenLabs once and discarded.

### Voice mode

Voice mode is a call with the chat's agent. Open it with the voice button in a
chat's header. In a new chat, the button starts the chat first.

The call shows the agent's name and face, how long the call has run, and two
captions: what you said last and what the agent said last.

- **Listening**: say what you need. When you pause, what you said is sent as an
  ordinary message in the chat, exactly as if you had typed it. Memory, rules,
  approvals and the tool trail work the same way.
- **Working**: the agent is on it, and the trail shows what it is doing. The
  call keeps talking while it works:
  - Ask how it is going, or anything quick, and you get a short answer out loud.
  - Every so often, when a step finishes, it tells you where it has got to, for
    example "I've read two of the three pages." It waits at least 25 seconds
    between these, never talks over you, and says nothing in the first few
    seconds of a quick answer.
  - Say **stop**, **pause** or **carry on** and the work stops, pauses or
    carries on, the same as the buttons.
  - Anything else meant for the work, like "also check the second site" or
    "make it shorter", is kept as your next message. The call says so, shows it
    under the captions as **Next message**, and sends it the moment the current
    work finishes. If you stopped the work, or the call ends first, it waits in
    the message box instead.
- **Speaking**: the reply is read aloud a sentence or two at a time, as it
  arrives. Start talking and it stops.
- **Mute** stops sending your microphone without ending the call. **Minimise**
  shrinks the call to a bar above the message box, so you can read, scroll and
  type in the chat while it goes on; **Open** brings it back. **End**, or
  Escape, closes it and releases the microphone.

The talking while it works is a separate, light model call alongside the
work. It sees the conversation, what the work has done and is doing, and the
agent's name. It has no tools: it cannot do anything, approve anything or
change the work itself. A stop, pause or next message goes through the same
controls and message box you use.

Decisions are never made by voice. When a reply needs your decision, voice
mode says "This needs your decision. It is on the screen." and stops reading.
The card is in the chat above; **Show the decision** brings it into view.
Anything you ask for while a decision waits is kept as your next message until
the decision is made.

Neither your voice nor the spoken reply is stored. Your words are kept as the
chat message they became, and the reply as the chat message it already is.
What you say to the agent while it works, and what it says back, is not kept
anywhere; only a next message it passed on becomes a chat message.

## Privacy

ElevenLabs is a cloud service. Voice sends it audio and text directly, not
through the model gateway (voice mode's microphone goes from your browser
straight to ElevenLabs), so the
[privacy router](PRIVACY-ROUTER.md) does not redact or reroute any of it. What
ElevenLabs receives:

| Feature | Sent to ElevenLabs | Not sent |
| --- | --- | --- |
| Push-to-talk | The recording, under a generic file name such as `clip.webm`, and the model name. | The chat, the message box, your name, the space. |
| Voice mode, listening | Your microphone as 16 kHz audio while voice mode is open and not muted, over a single-use token the service asked for. | The key; the chat's other messages. |
| Voice mode, speaking | Each piece of the reply that is read aloud, as text, up to 2,000 characters a request. | The rest of the chat, memory, tool results that are not in the reply. |
| Voice mode, while it works | What the agent says back, as text, to be read aloud. | The rest of the chat, memory, tool results. |
| Speech (`audio.synthesize`) | The script you approved, and the voice and model settings. | Anything else from the space. |
| Transcription (`audio.transcribe`) | The file you approved, and the model settings. | Anything else from the space. |

The talking while Melete works is different: it is a model call, not a
speech call, so it goes through the model gateway and the privacy router like
every chat turn. The conversation and the activity it is shown are redacted,
or kept on your local model, exactly as the work's own requests are, and the
call is refused wherever voice is off.

Every request from the service carries its ElevenLabs key; the browser uses
only the single-use token. Melete keeps no push-to-talk or voice mode audio;
ElevenLabs' own terms govern what it keeps.

Because none of this can be kept on your own machine, push-to-talk and voice
mode are off where the privacy router keeps work off cloud models:

- a space marked private in **Settings → Privacy**;
- a chat with an agent marked private there, including a new chat about to be
  started with that agent;
- a conversation the router found to be about therapy, health records or
  personal finances.

There the microphone and voice mode buttons say why instead of recording, and
the service refuses the request before it reads any audio or text
(`voice_private`, 403). If the privacy settings cannot be read, voice is off too.
Speech and transcription as agent capabilities are not turned off this way:
each one shows you the exact script or file and waits for your approval before
anything is sent.

## If something goes wrong

Every problem is shown in the chat in plain words, for example:

| You see | It means |
| --- | --- |
| Melete can’t use your microphone. | The browser refused the microphone. Allow it for this site in the browser's site settings. |
| Voice messages can be up to 2 minutes. | The recording was longer than the limit. |
| You have used today’s allowance… | The person reached a daily limit above. It frees up as the day's use ages past 24 hours. |
| The speech service could not … just now. | ElevenLabs refused or did not answer. Check the key and your ElevenLabs quota. |
| The voice connection ended. | The realtime connection closed. Press **Start again**; it opens a new session. |
| Voice is off here because this space or its agent is marked private. | See [Privacy](#privacy). Voice would send your words to ElevenLabs. |
| Voice is off in this conversation because it looks like it is about a sensitive topic. | See [Privacy](#privacy). Start a new chat to use voice for something else. |
