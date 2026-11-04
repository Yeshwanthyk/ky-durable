#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * strobe.json's `serve`: the stack perf/build.ts built, on `port`, over a fresh copy of the state it seeded, so
 * every bench block starts from the same week of use. Stops on SIGTERM or SIGINT.
 */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStack } from "../test/harness/stack.ts";
import { BUILT, OUT, STATE } from "./stack.ts";

const port = Number(process.argv[2]);

if (!Number.isInteger(port)) throw new Error("usage: perf/serve.ts <port>");

const state = mkdtempSync(path.join(tmpdir(), "ky-perf-"));

cpSync(STATE, state, { recursive: true });

process.env.KY_STACK_STATE = state;

const stack = await startStack(path.join(OUT, `serve-${port}.log`), { built: BUILT, port });

console.log(`perf serve: ${stack.url} on ${state}`);

const stop = async () => {
  await stack.stop();
  process.exit(0);
};

process.on("SIGTERM", stop);

process.on("SIGINT", stop);
