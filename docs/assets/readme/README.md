# README media

Product captures use the Melete web app with the scripted development API and
invented workspace data. They demonstrate the interface and workflow; no real
mail was sent, money recovered, or restaurant booking made during capture.

| Asset | Source |
| --- | --- |
| `demo.gif` and `walkthrough/` | Existing September 25 Companies walkthrough, recorded from the web app against the sample company-chase scenario |
| `follow-through.mp4` | H.264 copy of `demo.gif`, with a one-pixel pad for even video dimensions |
| `computer.png`, `computer.gif`, `computer.mp4` | October 22 capture of the app at commit `ca2d4b551`, using the `book-a-table` development scenario; shows the browser, terminal, takeover, hand-back, and approval |
| `memory.png`, `work.png`, `connections.png`, `companies.png` | October 22 captures of the same app's seeded Memory, Work, Connections catalog, and Companies views |

The booking page inside the computer is a fixture, rather than a live capture
of the external site. All account names, tasks, totals, and addresses are sample
data. The screenshots retain the app's content and are clipped to the relevant
panel for readability in the feature gallery.

To refresh captures, use the interface development setup in
[Contributing](../../../CONTRIBUTING.md#work-on-the-interface), with a disposable
browser profile. Keep its mock API and web ports separate from running work.
Capture the app itself, wait for fonts and images to load, and verify that the
media shows current controls. Keep static design compositions separate from
product screenshots.

The looping GIFs work directly in GitHub's README renderer. Their MP4 companions
offer playback controls and smaller downloads; the linked PNGs offer a still
view. Capture scripts, browser profiles, and raw recordings are not included.
