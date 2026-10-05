import type { ModelsTestObject } from "./models-fixture";
import type { PiHarnessTestObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      PI_HARNESS_TEST: DurableObjectNamespace<PiHarnessTestObject>;
      MODELS_TEST: DurableObjectNamespace<ModelsTestObject>;
      /** A fake VibeProxy that answers, where VIBEPROXY refuses connections. */
      VIBEPROXY_UP: Fetcher;
    }
  }
}

export {};
