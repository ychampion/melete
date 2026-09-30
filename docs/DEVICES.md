# Connect your own computer

Your agent has its own computer to work on. With your permission it can also use yours: open a
page in your browser, look through a folder you chose, take a screenshot, or run a command you
approved. A small companion program on your computer makes that possible. It connects out to
your Melete and does only what you allow, and you can switch any of it off or disconnect the
computer at any time.

## Connect a computer

You need [Bun](https://bun.sh) 1.3 or newer on the computer, and a copy of this repository.

1. In Melete, open **Settings → Devices** and choose **Connect a computer**.
2. Choose what your agent may do there (see below), then **Make a code**. The code works once and
   expires after ten minutes.
3. On the computer, from the repository folder, run the command the dialog shows:

   ```sh
   bun packages/device/src/cli.ts pair --url https://your-melete.example --code ABCD-EFGH
   ```

   The companion asks for a name for the computer, the folders to share, and what to allow on
   this side. Then it stays connected and prints every request as it arrives. Press Ctrl+C to
   disconnect for now; run `bun packages/device/src/cli.ts` again to reconnect.

Without flags, `pair` asks for the address and the code. Flags let you pair without prompts:

| Flag | Meaning |
|---|---|
| `--url <address>` | The address you open Melete at |
| `--code <code>` | The pairing code from Settings |
| `--name <name>` | What the computer is called in Melete (defaults to its host name) |
| `--folder <path>` | A folder to share; repeat for more |
| `--allow commands,files,open_url,screenshot` | What this computer allows; anything left out is off |
| `--no-start` | Pair, save, and exit without connecting |

## What it can do

Each capability has to be allowed twice: in **Settings → Devices** and on the computer itself. The
computer's choice always wins, and it is checked on the computer before anything runs.

| Capability | Tools the agent gets | Starts | Approval |
|---|---|---|---|
| Use files in shared folders | `device.list_files`, `device.read_file`, `device.write_file` | On | Writing a file asks you first; listing and reading do not |
| Run commands | `device.run` | **Off** | Every command asks you first, showing the exact command |
| Open web pages | `device.open_url` | On | No |
| Take screenshots | `device.screenshot` | Off | No |

`device.status` is always available: it tells the agent whether the computer is online, what it
allows, and the names of its shared folders.

A standing rule you made with **Always allow** can let a command or a file write through without
asking, the same way rules work for every other connection. Revoke the rule in **Settings → Rules**
and the agent asks again.

Every action on your computer leaves a receipt in the conversation, like any other action: the
command and its output, the file and its content hash, the page that was opened, or the
screenshot, which is kept with the task's files.

### Limits

| Limit | Value |
|---|---|
| Command time limit | 30 seconds by default, 2 minutes at most; the command and everything it started is stopped |
| Command output kept | 64 KB of each of standard output and standard error; the rest is dropped and marked |
| Largest file read or written | 1 MB |
| Entries in one folder listing | 500 |
| Largest screenshot | 8 MB |
| Shared folders per computer | 20 |

## What it cannot do

- **Reach outside the folders you shared.** A file path is a shared folder's name followed by a
  path inside it, like `Projects/notes/todo.md`. Absolute paths, drive letters, `..`, backslashes
  and Windows device names are refused by Melete before anything is sent, and again by the
  companion. The companion does not follow symbolic links or junctions inside a shared folder, and
  it checks that whatever it opens really is inside the folder.
- **Accept connections.** Nothing on your computer listens. The companion keeps one outgoing
  connection to Melete and collects requests from it.
- **Run a command without you seeing it.** Commands are off until you turn them on on both sides,
  and each one waits for your approval unless a rule you made covers it. A command runs as you, in a
  shared folder, so treat approving one like typing it yourself: it is not confined to the folder.
- **Open anything but a web page.** Only `http` and `https` addresses are opened, with the
  operating system's own opener and no shell in between.
- **Keep working after you disconnect it.** Revoking stops the token at once.

## What stays on your computer

The companion keeps its settings in your user configuration folder, readable only by you:

| System | Folder |
|---|---|
| Windows | `%APPDATA%\melete-device` |
| macOS | `~/Library/Application Support/melete-device` |
| Linux | `$XDG_CONFIG_HOME/melete-device`, or `~/.config/melete-device` |

`config.json` holds Melete's address, the device token, the shared folders and what this side
allows. `activity.log` records every request and whether it ran. Melete stores only a hash of the
token and of the pairing code.

Change things on the computer at any time; a running companion tells Melete within a few seconds:

```sh
bun packages/device/src/cli.ts status
bun packages/device/src/cli.ts folders add ~/Projects
bun packages/device/src/cli.ts folders remove Projects
bun packages/device/src/cli.ts allow screenshot
bun packages/device/src/cli.ts deny commands
```

## Disconnect a computer

- **From Melete:** Settings → Devices → **Disconnect**. The token stops working immediately,
  anything waiting for that computer is cancelled, and a running companion deletes its copy of the
  token and exits. To use the computer again, pair it with a new code.
- **From the computer:** `bun packages/device/src/cli.ts forget` deletes the token kept there.
  Disconnect it in Settings too, so the token cannot be used again.

## When the computer is off

A request for a computer that is not connected is not sent, and the action says so. A request the
computer collected but never answered, for example because it went to sleep mid-command, is
recorded as unknown rather than retried, because it may have run.
