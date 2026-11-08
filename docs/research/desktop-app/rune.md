# A desktop and mobile ky built with Rune

Researched 2026-11-07 against rune `dev` at `59f0326b` (2026-11-07) and ky `main` at `670999e8`.

## Answer

Rune can't wrap ky's existing web app. It is a native Rust UI framework that draws with the GPU through wgpu, with its own
text, layout and animation. It isn't a webview shell like Electron or Tauri. A Rune ky means a new client written in Rust
that talks to the same Worker and Durable Object over the same WebSocket. That works on macOS, Windows and Linux today.
**Rune has no iOS or Android support yet.** In Rune's roadmap, iOS is milestone M6 and Android is M7.

## Facts

| Claim | Source | Status |
| --- | --- | --- |
| Rune is a native GPU-rendered Rust UI for macOS, Windows, Linux and the web | rune `README.md` | documented |
| Its platform shells are macOS, win32, x11 and web, with none for iOS or Android | `crates/rune/src/platform/` listing | checked |
| iOS is M6 (a `UITextInput` shell, a `RuneView` that embeds in SwiftUI) and Android is M7, both after desktop and web | rune `PLAN.md` §10 | documented |
| It is pre-release: you pin a rev of `dev` | rune `README.md` | documented |
| Rune has no HTTP client on native, so you bring your own (`reqwest`, `tokio-tungstenite`) | `crates/rune/README.md` ~L1796 | documented |
| Embedding a `WKWebView` in a Rune window is a research idea and hasn't been built | `research/11-platform-shells.md` | documented |
| rune-kit has a Markdown renderer with streaming, code highlighting, diffs and tables, which covers ky's transcript | `crates/rune-kit/README.md` §Markdown, §Diff | documented |
| The web target draws a single WebGPU canvas from the same Rust views | rune `WEB.md` | documented |
| ky's browser client is React: `src/ui` (97 files) plus chat-kit, the session hook and the protocol, about 25.9k lines | `wc -l` on ky | checked |
| The client speaks `wss /agents/pi-agent/me?session=<id>` and rebuilds from a snapshot on reconnect | ky `docs/architecture.md` | documented |
| The Worker sits behind Cloudflare Access (`Cf-Access-Jwt-Assertion`) | ky `src/access/contract.ts` | checked |
| ky already ships as an installable PWA (`display: standalone`, a service worker) | ky `public/manifest.webmanifest`, `public/sw.js` | checked |

## What a Rune client needs

1. **A Rust crate in the repo** (for example `apps/desktop/`) that pins `rune` and `rune-kit` to a `dev` rev and starts
   from `examples/hello` and `examples/web-hello`.
2. **The protocol in Rust.** Mirror `src/protocol.ts`, `src/server-frames.ts` and `src/client-messages.ts`. Generate the
   Rust types from the Effect schemas through JSON Schema rather than copying them by hand, so CI catches drift.
3. **Sign-in.** A browser has the Access cookie and a native app doesn't. Options: the `cloudflared access login`
   style flow, which opens the browser and hands the app a token, or an Access service token for the owner's own
   devices. The app sends the token as `cf-access-token` or the `CF_Authorization` cookie.
4. **The transport.** A `tokio-tungstenite` WebSocket per open chat, with reconnect and snapshot rebuild as
   `src/use-pi-session.ts` does.
5. **Porting the UI one screen at a time.** Main chat first (rune-kit Markdown in streaming mode, the composer), then
   side chats, tasks, Settings. React keeps serving the web until a screen is at parity.

## Open questions

- When will M6 (iOS) ship? Nothing in the repo gives a date.
- Mobile today: the web target needs WebGPU in mobile browsers. Recent Safari has WebGPU, but this is inferred, not
  checked here. Rune's own notes say its mobile keyboard handling was tested only in Chromium emulation, not on a real
  iPhone (`WEB.md` ~L252).
- Is a Rust rewrite of about 26k lines of UI worth it, compared with Tauri 2 (desktop and mobile, reusing the React app)
  or the existing PWA? This is a product decision for the owner.

## Built: the macOS client

`apps/mac` is the first Rune client: the main chat, live against the local stack, in the web's tokens and layout.
See `apps/mac/README.md` for how to run and measure it. Not yet ported: the sidebar chat list, the Activity panel,
turn timing ("Worked for 12s"), and the Changes row under a machine report.

## Letting ky use a browser: anomalyco/browse

`browse` drives a real browser and exposes it as an MCP server (`browse mcp`). ky's tools run on the user's machine
through the runner socket, so the bridge is: the runner starts `browse mcp` on demand and forwards its tools to ky as
`browser.*` tools; results (snapshots, screenshots) come back as tool results the transcript already renders.

- The browser stays on the user's machine with the user's sessions; ky never sees cookies, only page snapshots.
- Each navigation outside an allow list asks first, as machine commands do.
- Name clash: ky already has a `browse` tool (Kitesurf). Name the new tools `browser.*`.
- The Mac app doesn't need to embed the browser; it shows the tool results like any other.

## Rat Stack (ratstack.sh)

Not a UI framework, so it doesn't replace Rune. Two parts are worth taking:
- Its security checklist, for the native app's sign-in and token storage (Keychain, not env vars).
- Its "one schema, every interface" pattern: generate `wire.rs` from ky's Effect schemas (via JSON Schema) so the
  Rust client can't drift from the protocol.
