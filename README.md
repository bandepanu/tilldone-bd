# tilldone-bd

A *work-till-it's-done* task-discipline extension for [pi](https://github.com/earendil-works/pi), backed by the [beads](https://github.com/gastownhall/beads) issue tracker (`bd`).

The agent must define an in-progress task (`tilldone toggle`) before it can use blocking tools, and gets nudged on completion to finish or close whatever remains. Tasks persist across sessions in the project's beads store, so the list survives a restart — no more losing track mid-task.

## Requirements

- [pi](https://github.com/earendil-works/pi) coding agent
- The beads CLI (`bd`) on `$PATH` — this is the **`@beads/bd`** npm package, installed globally:
  ```
  npm install -g @beads/bd
  ```
  Only `bd` from `@beads/bd` is used (this extension shells out to it). There are several *other* beads-named packages on npm (`beads-ui`, `@herbcaudill/beads-ui`, `pm-beads`, the `beads` package, and AI-tool integrations like `opencode-beads`) — none of those provide the `bd` CLI and none are required. If in doubt, check: `bd --version` should print a version number.

## Install

As a pi package (once published):

```
pi install npm:tilldone-bd
```

Or drop it into your global extensions folder:

```
cp extensions/tilldone-bd.ts ~/.pi/agent/extensions/
```

Then restart pi (or run `/reload`).

## Usage

| Action | Command |
|--------|---------|
| Start a themed list | `tilldone new-list --text "Title" --description "..."` |
| Add a task | `tilldone add` |
| Mark a task in progress | `tilldone toggle <id>` |
| Finish a task | `tilldone toggle <id>` (again) |
| Clear the list | `tilldone clear` |

Task lifecycle: `idle → inprogress → done`. While no task is in progress, write/execute tools are gated until one is started.

A `/tilldone` interactive overlay, a footer task list, and a status-line summary are provided as TUI surfaces.

## How storage works

One beads label per list (`f_slug(listTitle)`, default `tilldone`); the active-list pointer lives in `<project>/.beads/tilldone.json`. Statuses map to beads states: `idle ↔ open`, `inprogress ↔ in_progress`, `done ↔ closed` (blocked/deferred read as idle).

## License

MIT