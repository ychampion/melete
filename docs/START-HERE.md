# Your first useful Melete session

Go from a fresh installation to an agent that knows a little about you and has something useful to do. For the full operating reference, see [Deployment](DEPLOYMENT.md). For a coding agent doing the installation, see [Setting up Melete](../SETUP-WITH-AN-AGENT.md).

## 1. Choose its home

| Where | What to expect |
| --- | --- |
| Your computer | A quick way to start. Background work runs while that computer and Docker are awake. |
| An always-on Linux machine or VPS | Routines and long jobs keep running when your laptop sleeps. Use [server setup](DEPLOYMENT.md#on-a-cloud-vm) and [HTTPS or Tailscale](DEPLOYMENT.md#tailscale) for remote access. |
| Melete Cloud | Hosted access is opening through the [Cloud waitlist](https://waitlist.melete.si). Self-hosting is available now. |

For a fresh self-hosted install, have **Docker Engine 28+ and Compose 2.33.1+** running. Docker Desktop on Windows needs Linux containers and [Git for Windows](https://gitforwindows.org/). See [machine checks](../SETUP-WITH-AN-AGENT.md#2-check-the-machine) for disk, ports, and platform requirements.

The prebuilt installer below uses **x64 (`linux/amd64`) images**. For Apple silicon and other ARM hosts, follow the [coding-agent source-build guide](../SETUP-WITH-AN-AGENT.md) and the [image architecture guidance](DEPLOYMENT.md#using-prebuilt-images).

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/install.sh | bash
```

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/ychampion/melete/main/install.ps1 | iex
```

The installer downloads prebuilt images and starts the stack. Follow the setup link it prints; it includes the code for claiming your installation. Create your account there. The usual address is **http://localhost:3101**.

An existing installation should be updated in its original directory. The installer defaults to `~/melete`; [installer options](DEPLOYMENT.md#one-line-install) explain other directories, projects, and ports. Keep separate installations separate.

## 2. Give it a model

Open **Settings → Models**, choose your provider, enter your key or use **Sign in with ChatGPT**, then **Test connection**, choose a model, and save. Keys go directly into Melete.

The practice model is for exploring the interface. Connect a working model before expecting real research or actions. You can change providers later while keeping your memory and work. [Supported providers](DEPLOYMENT.md#providers).

**First check:** send a short message and confirm you get a reply from the model you chose.

## 3. Skip the blank-slate introduction

During onboarding, share your city, important people, current focus, and preferred check-in style if you want. Then bring a short preferences file from an assistant you already use:

1. Give it the [context-export prompt](BRING-YOUR-CONTEXT.md#ask-your-current-assistant).
2. Review the result and save it as Markdown.
3. In Melete, open **Memory → Import** and select the file.
4. Ask Melete to describe what it knows and check anything ambiguous.

You can also start with the [context template](templates/PERSONAL-CONTEXT.md), or simply tell Melete a few facts in chat. Keep the first import small enough to read in one sitting.

## 4. Connect one account that makes it useful

The **Agent library** offers ready-made agents with a brief, a connection checklist, preference questions, and a starter routine you can choose to enable. Preview one that fits your first task, or continue with your existing agent.

Choose the sources your first task needs: notes, files, links, or a connected account. A learning plan or project brief can begin with material you provide. For mail or calendar work, open **Settings → Connections** and follow [Mail and calendars](mail-calendar.md).

Account sign-in connects the account; the **Watch** switch controls automatic mail/calendar checks. If you want proactive work, enable it for the account involved. Google/Microsoft OAuth and the managed app catalog may need operator setup first. [Connection configuration](CONNECTORS.md).

For a browser task, use the agent's own [Docker computer](sandbox-docker.md). For your already signed-in browser or selected local folders, [pair your computer](DEVICES.md). Set up the capability the first task actually needs.

## 5. Pick a finish line

Choose one [playbook](PLAYBOOKS.md), then describe the result you want, the relevant constraints, and what should come back to you for review.

```text
Turn these side-project notes into a launch brief. Ask about the goal if
it isn't clear, compare the main approaches, and recommend a first milestone
that fits five hours a week. Save the brief and open questions in a file.
Done means I can open the file and know what to work on next. Bring the
choice of approach back to me before making commitments on my behalf.
```

Open **Work** to see the running job or anything waiting on you. Check the output against the finish line. Correct one preference in **Memory** if it would make the next task better.

## 6. Make it part of your day

Once one task works, add a weekday brief, a weekly project review, or a recurring practice prompt. Start with a small scope and choose sending preferences in Settings. [Watching for changes](SITUATIONAL-AWARENESS.md), [persistent goals](INTENTS.md), and [long runs](RUNS.md) explain how work continues.

Keep the host running for unattended work. A paired laptop's browser and files are available only while its companion is connected; an always-on server does not keep a sleeping laptop online.

## Keep it running

Rerun the original installer command to update. It preserves `deploy/.env`, configuration, and data volumes. For pinned versions, backups, restore, and operating checks, use [Deployment](DEPLOYMENT.md#using-prebuilt-images) and [Backup and restore](DEPLOYMENT.md#backup-and-restore).

If setup fails, begin with [machine checks](../SETUP-WITH-AN-AGENT.md#2-check-the-machine) and the relevant deployment section. For a useful issue report, include your OS, Docker versions, the step that failed, and redacted output.

## Prompt for your coding agent

```text
Read https://github.com/ychampion/melete/blob/main/docs/START-HERE.md
and SETUP-WITH-AN-AGENT.md in that repository. Set up my personal Melete.

Inspect the machine, its architecture, and any existing installation first.
For x64, use the prebuilt installer from START-HERE; for ARM, follow the
source-build path in SETUP-WITH-AN-AGENT. Keep existing files,
volumes, and services intact; use the deployment guide for custom paths.
Do not put credentials, setup codes, or session tokens in this chat.
Have me claim the installation and connect a model directly in its UI.

After I can chat, help me prepare a small reviewed preferences file using
docs/BRING-YOUR-CONTEXT.md. Choose one useful first task with me from
docs/PLAYBOOKS.md and help me check its result. Finish with the local URL,
where this installation lives, and how to update it and back it up.
```
