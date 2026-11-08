# ky for macOS (Rune)

A native ky client drawn with [Rune](https://github.com/anomalyco/rune): the main chat, streamed, in the web app's look.
It talks to the same Worker over the same socket as the web (`/agents/pi-agent/me?session=1`).

## Run

```sh
pnpm stack                      # the local ky, from the repo root
apps/mac/scripts/dev            # signs in with the stack's FakeAccess token, builds, opens the window
apps/mac/scripts/dev --profile perf
apps/mac/scripts/run            # your own ky: pick a Cloudflare login, then a ky it holds, then sign in to its Access
```

`scripts/run` signs the build with your Apple Development identity, so the Keychain's "Always Allow" for the
saved sign-in lasts across rebuilds; an unsigned rebuild asks for your login password again.
`KY_URL` and `KY_TOKEN` point it elsewhere.

## Layout

| File | Owns |
| --- | --- |
| `src/link.rs` | The socket thread: connect, reconnect, keepalive, decode. Hands the UI one batch per 120 Hz frame. |
| `src/wire.rs` | The protocol frames, decoded off the UI thread. |
| `src/chat.rs` | Events → rows. Each row has a `rev`; the chat has a `layout_rev`. Fixtures for scenes. |
| `src/theme.rs` | The web's tokens (`src/chat-kit/chat.css`) as Rune values. Change the web first, then here. |
| `src/view.rs` | The window: sidebar, tab bar and page; a chat's virtual transcript and composer; the headless scenes. |
| `src/shell.rs` | The sidebar (main chat, side chats by day, Archived folded away, hover Archive/Unarchive) and the tab strip (rune-kit `TabStrip`: drag to reorder, close). |
| `src/settings.rs` | The Settings tab: General, Models (sends `set-model`), Subscriptions. |
| `src/kys.rs`, `src/signin.rs` | Which ky (CLI records or a typed address) and its Cloudflare Access sign-in; tokens in the Keychain. |
| `src/time.rs` | The sidebar's day headings and ages, as the web writes them. |

Shortcuts: ⌘T/⌘N new chat, ⌘W close tab, ⌘1–9 a tab, ⇧⌘[ / ⇧⌘] previous/next, ⌘, Settings, ⌃⌘S sidebar.
Scenes: `KY_OFFLINE=1 target/release/ky-mac --snap out.png --scene desktop|archived|settings|models|long|streaming|empty`.

Every rebuild is a new ad-hoc signature, so macOS asks again for the saved token's Keychain item; until
"Always Allow" is clicked the window shows Connecting….

## Perf rules

- The transcript is `virtual_rows`; only rows near the viewport are built.
- Each row is `memo`'d by `(key, rev, dark)`, so a streamed delta rebuilds one row.
- `poll` returns false when nothing visible changed: an idle window draws nothing.
- No JSON parsing and no blocking I/O on the UI thread.

## Measure

Every headless run prints frame CPU p50/p95/max, layout nodes and instances.

```sh
cargo build --profile perf
KY_OFFLINE=1 target/perf/ky-mac --scene long --snap /tmp/long.png       # 400 turns
KY_OFFLINE=1 target/perf/ky-mac --scene streaming --snap /tmp/stream.png
KY_TOKEN=… target/perf/ky-mac --script bench/send.json --snap /tmp/sent.png --at mark:end   # live, against the stack
```

Budgets (measured on an M-series Mac, release, against the local stack, 2026-11-07):

| Measure | Now | Budget |
| --- | --- | --- |
| Frame CPU p50 | 0.40 ms | ≤ 1 ms |
| Frame CPU p95 | 0.52 ms | ≤ 2 ms |
| Layout nodes, 400-turn chat | ~385 | ≤ 600 (independent of chat length) |

A change that moves a number past its budget needs a reason in the PR.
