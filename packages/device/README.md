# melete-device

The companion that connects your own computer to your Melete agent, on Windows, macOS or Linux.
It holds one outbound connection, uses only the folders you share, and asks you in Melete before
it runs a command or changes a file.

```sh
# Get a code from Settings → Devices, then:
bun packages/device/src/cli.ts pair --url https://your-melete.example --code ABCD-EFGH
```

Setup, what it can and cannot do, and how to disconnect: [docs/DEVICES.md](../../docs/DEVICES.md).

| File | What it does |
|---|---|
| `src/cli.ts` | Pairing, connecting, and changing settings from the command line |
| `src/agent.ts` | The outbound long poll, the activity log, and answers to Melete |
| `src/policy.ts` | The checks made on this computer: capabilities, shared-folder paths, links, web addresses |
| `src/tools.ts` | Listing, reading and writing files, running commands, opening pages, screenshots, with their limits |
| `src/config.ts` | Where settings and the token live, written readable only by you |
| `src/browser.ts` | The browser bridge: native messaging with the extension, its own poll, and `browser install` |
| `extension/` | The Melete browser extension: tabs it opens, the bar with Stop, and the page actions |

Tests: `bun test packages/device`.
