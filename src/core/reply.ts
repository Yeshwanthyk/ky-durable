import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** A tool's answer to the model as one text, marked an error when `isError`. */
export function toolReply(text: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text }], isError };
}
