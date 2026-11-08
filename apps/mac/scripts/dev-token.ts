// Print a sign-in token the local stack accepts (FakeAccess), for KY_TOKEN. Local stack only.
//   KY_TOKEN=$(node --experimental-strip-types --no-warnings apps/mac/scripts/dev-token.ts) apps/mac/target/release/ky-mac
import { accessCookie } from "../../../src/tests/fake-access.ts";

const base = process.env.KY_URL ?? "http://127.0.0.1:8790";

process.stdout.write((await accessCookie(base)).value);
