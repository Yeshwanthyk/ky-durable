/** The compiled `ky`'s entry: the release it deploys is built into the binary (cli/compile.ts). */
import pack from "../dist/release.pack" with { type: "file" };
import { useRelease } from "./release.ts";

useRelease(pack);

await import("./main.ts");
