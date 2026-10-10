# Live benchmark

The live benchmark runs real tasks against a running Melete install, with its real model, and scores the result against the bars that say Melete is ready to charge for:

| Bar | Target |
|---|---|
| Logged-in errands done end to end | at least 80% of twenty real logged-in errands |
| A human check (captcha, bot check, 2FA) shown to the person as a needs-you card | within 10 s, every time |
| Errand median time / research median time | 3 min / 15 min |
| Claims of actions that did not happen | 0, across a 100-job run |
| Approvals per completed job | median of 1 or fewer |

It is the automated form of a hand-run real-use round. Where the lab in `evals/` runs the API, broker and engine against fixture destinations, this drives an install from the outside, over the same HTTP API the web app uses: it signs in, opens a chat, sends the task, follows the chat's event stream, answers every permission and question by policy, records the receipts, and deletes the chat.

## What a job does

1. If the task needs it, reads the site first (ParaBank's accounts, the files a download page lists) and makes fresh values, so the job's effect can be told from anyone else's.
2. Opens a new chat and sends the task the way a person types it.
3. Follows the event stream. Permissions are answered with Allow once (or Deny, per task), questions with a short "go ahead" or the first option. A card that hands the work to the person (Needs you, Take over) ends the job, since nobody is there to take over; its delay is timed from the end of the first browser or computer step that reached the checked page. Only hand-offs in tasks that meet a human check by design are timed against the bar; one anywhere else fails its errand.
4. Waits for background work the turn started, within the same budget.
5. Stops the chat when the task's time budget runs out. This is a hard limit: a turn that hangs is stopped, not waited on.
6. Reads back the final answer, receipts and cards, runs the task's check, and deletes the chat with what it taught memory. Accounts or records the task made on a practice site are removed through that site's API. Files the jobs saved are removed at the end through one chat that asks Melete to delete them.

## The task set

`bun run evals/live/run.ts --list` prints it, with each task's tier.

The set has two tiers, and only the real tier is scored against the bars.

**Practice tier** (`--tier practice`): demo sites built to be automated. They have no real bot checks, two-step logins or accounts, which is where agents fail on real sites, so they are a deterministic regression signal and are reported in their own table, never toward a bar.

- **Errands**: twenty logged-in tasks with each site's published demo login: Sauce Demo (checkout, sorting, a locked account, cart edits), The Internet (login, logout, basic auth, dynamic controls, a file download), ParaBank (a transfer, a bill payment, the account list, a loan), OrangeHRM (add an employee, count users), Automation Exercise (sign up and order), the nopCommerce demo (register), Practice Test Automation, Quotes to Scrape and DemoQA.
- **Human checks**: a reCAPTCHA demo page, a Cloudflare Turnstile demo page and the nopCommerce guest checkout behind its bot check. They pass when a needs-you card is shown within 10 s.

**Real tier** (`--tier real`): real sites and real accounts.

- **Lookups** (`lookup`): read-only questions on real sites that guard themselves against bots: Google Flights, Google Maps transit, Best Buy, Kayak, Zillow, Wikipedia, and G2 behind Cloudflare. Nothing is bought, booked or submitted. They are reported beside the bars; a needs-you card on any of them is timed against the hand-off bar.
- **Logged-in errands** (`errand`): on accounts that exist. GitHub on a test account (open and close an issue, read the repository's settings, read the notifications), plus slots for accounts the owner may add: a throwaway email account, Reddit and a store account. A slot is skipped as "account not provided" until its variables are set; it is never stood in for by a demo site.
- **Two-step check** (`human_check`): GitHub's sudo prompt before the security settings, in a browser signed in to the test account. Skipped until that is set up, and reported as not covered.
- **Research** (`research`) and **everyday** asks (`everyday`): questions that need several sources, a store page, a PDF to fetch, a long article read to the end, a PDF to make.

The errand bar is measured over twenty real logged-in errands. Until that many are available, the report gives the rate and says "≥80% not measurable yet: N of 20 real errands available"; practice errands never fill the gap.

Checks are deterministic where the site allows it. ParaBank, OrangeHRM, Automation Exercise, GitHub and Wikipedia are read back through their APIs after the job, so a pass means the site changed or the answer matches it. Account slots compare the answer with what the owner read off the account. Elsewhere the check looks for the text only the finished flow shows, plus a step that actually reached the site. With `--rubric` and `FIREWORKS_API_KEY` set, the research answers also get a model grade, reported beside the check and never used for a bar.

### Adding a real account

Sign the agent's browser in to the account once, read the answer off the account yourself, and set the slot's variables:

| Slot | Variables |
|---|---|
| Email | `MELETE_BENCH_EMAIL_URL` (the webmail address), `MELETE_BENCH_EMAIL_FROM` (a sender), `MELETE_BENCH_EMAIL_EXPECT` (the subject of their newest message) |
| Reddit | `MELETE_BENCH_REDDIT_EXPECT` (the title of the newest saved post) |
| Store | `MELETE_BENCH_STORE_URL`, `MELETE_BENCH_STORE_EXPECT` (the total of the most recent order) |
| GitHub two-step | `MELETE_BENCH_GITHUB_BROWSER=1` once the browser is signed in to the test account |

### Claims against receipts

Every final answer is read sentence by sentence. A sentence that reports a delivery ("attached", "saved to your Files", "sent"), an action ("booked", "ordered", "submitted", "logged in") or a method ("in my browser", "searched the web", "ran a command") must have a step or receipt of that family behind it: a file card with Open or Download, a send receipt, a done browser or computer step, a done web search. Sentences that deny, offer or plan ("I couldn't attach it", "I can send it") are passed over. Each claim with nothing behind it counts against the claims bar and is listed in the report.

## Models

Only runs on a real model count. Errands and research measure what the agent can do and are meant to run on `accounts/fireworks/models/kimi-k3`, which sees and uses tools well; human checks and everyday lookups measure speed and are meant to run on `accounts/fireworks/models/deepseek-v4p1-flash`. An install answers every chat with the model set in its settings, so the benchmark never changes it: it reads the active model (and whether screenshots are shown to it) before each job, records it beside the model the task wants, and the report says which jobs ran on a different one. Run each class with the install set to its model.

## Run it

Credentials come from the environment and are never written to a result:

```sh
export MELETE_BENCH_URL=https://melete.example.com   # the web app; /api is found from it
export MELETE_BENCH_EMAIL=you@example.com
export MELETE_BENCH_PASSWORD=...
# Optional: the GitHub errand, on a test account and repository only
export MELETE_BENCH_GITHUB_REPO=owner/test-repo
export MELETE_BENCH_GITHUB_TOKEN=...                  # fine-grained, that repository only

bun run evals/live/run.ts --tier real                              # the scored tier, each task once
bun run evals/live/run.ts --tier practice                          # the regression tier
bun run evals/live/run.ts --jobs 100 --spend-cap 10                # the 100-job run
bun run evals/live/run.ts --task sauce-checkout,parabank-transfer  # chosen tasks
```

| Option | Meaning |
|---|---|
| `--category` | Comma-separated categories; all by default |
| `--tier` | `real`, `practice` or both; both by default |
| `--task` | Comma-separated task ids |
| `--jobs N` | Sample N jobs from the selected tasks, with repeats, by `--seed` |
| `--spend-cap` | Dollars of model spend (as the install records it for the account) after which no new job starts; default 5 |
| `--out-dir`, `--name` | Where `<name>.json` and `<name>.md` go; `.eval-state/live/` by default, which Git ignores |
| `--rubric` | Model grade for tasks that define one |
| `--keep-chats` | Leave the chats in place for inspection |
| `--hand-back N` | Hand an unexpected hand-off (one in a task that meets no human check by design) straight back up to N times, to see what the agent does next. Such a job still counts as not done end to end |

The run uses the account's own space. Jobs run one at a time, since an install has one agent computer per space. When the GitHub variables are set and the account has no GitHub connection, the run adds one for the run and removes it at the end. A site that does not answer is reported as down and left out of the bars, not counted as a failure. The JSON holds every job's answer, steps and receipts; the Markdown is the short report: the real-tier bars, the slots not covered yet, the practice table, a row per job, the claims, the worst failures and the clean-up.

Practice sites are shared with everyone who uses them: their data drifts and they go down. Read a single failure on a practice site against its reason before reading it as a product failure.

## Nightly

The runner needs only Bun and network access to the install. On the machine that hosts it, a systemd timer can run the real tier every night and keep the reports. The environment file holds the variables above and is readable by its owner only.

```ini
# /etc/systemd/system/melete-bench.service
[Unit]
Description=Melete live benchmark

[Service]
Type=oneshot
WorkingDirectory=/opt/melete
EnvironmentFile=/etc/melete/bench.env
ExecStart=/usr/local/bin/bun run evals/live/run.ts --tier real --spend-cap 5 --out-dir /var/lib/melete-bench

# /etc/systemd/system/melete-bench.timer
[Unit]
Description=Run the Melete live benchmark nightly

[Timer]
OnCalendar=*-*-* 09:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it with `systemctl enable --now melete-bench.timer`. A cron line does the same:

```cron
30 9 * * * cd /opt/melete && set -a && . /etc/melete/bench.env && set +a && bun run evals/live/run.ts --tier real --out-dir /var/lib/melete-bench >> /var/log/melete-bench.log 2>&1
```

Run the 100-job mode weekly rather than nightly, with a spend cap that fits the model.
