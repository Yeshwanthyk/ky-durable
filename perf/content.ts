/**
 * The long answers perf/build.ts has the fake model give (`reply: …` makes it answer with exactly that), and the
 * one chat.bench.ts streams: markdown as a model writes it, a heading, prose, a list, a table and a code fence,
 * so a chat renders every kind of block Streamdown and Shiki draw.
 */
export function answer(turn: number): string {
  return [
    `## Step ${turn}: what changed`,
    "",
    `Here is where turn ${turn} leaves things. The build is green again, and the flaky test was a race between the`,
    "socket closing and the retry timer, so the fix waits for the close before it schedules the next try.",
    "",
    "- Moved the retry into `onClose`, so it never fires on an open socket",
    "- Kept the backoff at 250 ms doubling to 8 s",
    `- Added a test that closes the socket ${turn} times in a row`,
    "",
    "| check | before | after |",
    "| --- | --- | --- |",
    `| unit | 412 passed, 1 flaky | 413 passed |`,
    `| e2e | ${turn % 7} retries | 0 retries |`,
    "",
    "```ts",
    "export function retry(socket: WebSocket, attempt = 0): void {",
    "  socket.addEventListener(\"close\", () => {",
    "    const wait = Math.min(250 * 2 ** attempt, 8_000);",
    `    setTimeout(() => connect(attempt + 1), wait); // turn ${turn}`,
    "  });",
    "}",
    "```",
    "",
    `That's turn **${turn}** done.`
  ].join("\n");
}

/**
 * The line every answer ends on, as the page shows it once the answer has streamed. The answer writes the number
 * in bold; the owner's message, which holds the same words, shows the asterisks, so only the answer matches.
 */
export const finished = (turn: number) => `That's turn ${turn} done.`;
