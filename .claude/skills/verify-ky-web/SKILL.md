---
name: verify-ky-web
description: Verify a ky change in the web UI. Start the local stack, drive the real app in Chromium with Playwright using roles and labels, and collect screenshots and traces. Use it after touching src/client.tsx, src/ui/, src/use-pi-session.ts, or anything the user sees in the browser.
---

# Verify ky in the web UI

Everything here runs on this Mac against the local stack. It never touches the deployed worker.

## Launch

1. If Chromium is missing, install it with `pnpm install --offline`, then `npx playwright install chromium`.
2. The whole suite: `pnpm test:web`.
   - Global setup (`test/web/global-setup.ts`) starts the local stack on a free port.
   - It also starts a real runner as the machine `webmac`, with a fake claude.
   - It tears both down at the end.
3. To drive one test or a few:
   - `pnpm test:web -g "<title words>"`.
   - Or start your own stack with `pnpm stack` in the background and wait until it is ready:
     ```sh
     until curl -fsS -o /dev/null http://127.0.0.1:8790/manifest.webmanifest; do sleep 1; done
     ```
   - Then run `KY_STACK_URL=http://127.0.0.1:8790 pnpm test:web -g "<title words>"`. Global setup reuses that stack, but still starts the `webmac` runner.
4. To use it yourself, open `http://127.0.0.1:8790/cdn-cgi/access/login`. It signs you in as the owner with the fake Access key, then goes to the app.
5. Teardown: Ctrl-C or SIGTERM `pnpm stack`.

## Doctor (read-only)

- `npx playwright --version`, plus `ls ~/Library/Caches/ms-playwright`: Playwright is installed and has a chromium build.
- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/manifest.webmanifest`: prints 200 when your stack is up.
- `npx playwright test --config test/web/playwright.config.ts --list`: lists every web test, without running any.
- `lsof -nP -iTCP:8790 -sTCP:LISTEN`: shows who owns the port.

## Drive

- Tests live in `test/web/ky.spec.ts`. Find elements the way a user does:
  - `getByRole` with an accessible name
  - `getByLabel`
  - `getByPlaceholder`
  - `getByText` for content
  - Don't use CSS or test ids.
- The helpers in the spec:
  - `open(page)`: sign in and load the app.
  - `send(page, text)`
  - `panel(page)`: the Activity and settings side panel.
  - `pick(page, slot, /Model/)`
  - `mac(page, "1" | "0" | "leaves")`: the Mac comes online, goes away, or has just left.
  - `network(page)`: watches the session socket. With `{ loseSubmits }` or `{ dropOnAnswer }` it injects faults.
- Prompts the fake model understands (`src/tests/stack.ts`, `CALLS`):
  - `machine@webmac [delay=MS] <task>`: runs a task on the runner.
  - `spawn …`: starts a subagent.
  - `gate`: calls a tool that waits until `POST /test/release`, which keeps a turn running.
  - Anything else is echoed back.
- Programs the fake Executor understands (`src/tests/fake-executor.ts`), once `connectExecutor(page)` has connected it:
  - `answer TEXT`: returns TEXT. As an automation's `gate`, `answer null` skips a fire and `answer ["x"]` runs it.
  - `fail TEXT`: fails with TEXT.
- Assert what the user sees: text, roles, enabled or disabled, and counts. To check what reached the server, use `network(page)`. It records each socket's submits, results and errors.

## Evidence

- For a failing test, `test-results/web/<test>/` holds a screenshot (`test-failed-1.png`) and a trace (`trace.zip`).
  - Open the trace with `npx playwright show-trace <path>`.
  - Read the screenshot to see what the user saw.
- `test-results/web-stack/` holds the stack log and the `webmac` runner's logs.
- In your report, quote the Playwright summary line (`N passed (Xs)`).

## Isolation

- The stack uses `src/tests/wrangler.jsonc` and a fresh temp state directory on every start. The runner's `HOME` and `KY_STATE_DIR` are under `test-results/web-stack/webmac/`.
- Tests share one stack, so a test that changes a setting (a model slot, the Mac) must restore it before it ends.
- Never point `KY_STACK_URL` at the deployed worker, and never use a real Access token.
- Don't commit anything under `test-results/` or `playwright-report/`; both are gitignored.
