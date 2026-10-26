import type { ExecutorVault } from "../../../src/executor/contract";
import { callOnce, executeOnce, executorExtension, ExecutorLink } from "../../../src/executor/legacy/executor";
import { programOutcome } from "../../../src/executor/legacy/executor-status";
import type { Side } from "./world";

type VaultStub = ConstructorParameters<typeof ExecutorLink>[0];

export const legacy: Side = {
  link: (vault: () => ExecutorVault, id: string, reach: typeof fetch) =>
    // SAFETY: B's ExecutorLink calls the stub's executor, status, put and remove, which the fake vault answers as the Vault does.
    new ExecutorLink(vault as VaultStub, id, reach),
  extension: executorExtension,
  callOnce,
  executeOnce,
  programOutcome
};
