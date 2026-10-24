import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The web e2e suite: ky's real web app in Chromium against the local stack,
 * which global-setup.ts starts with a real runner and the fake claude.
 * `pnpm test:web`. Failures keep a screenshot and a trace under
 * test-results/web/; the HTML report goes to test-results/web-report/.
 */

const repo = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  testDir: import.meta.dirname,
  outputDir: path.join(repo, "test-results/web"),
  globalSetup: path.join(import.meta.dirname, "global-setup.ts"),
  // One stack and one agent, `me`, shared by every test: run them one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(repo, "test-results/web-report"), open: "never" }],
    [path.join(import.meta.dirname, "outcomes.ts")]
  ],
  use: {
    baseURL: process.env.KY_STACK_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 860 },
        // A stand-in microphone and camera, for a test that records: a beep, granted without asking.
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }
      }
    }
  ]
});
