import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Approvals, type ApprovalDeps } from "../../../src/approvals/legacy/approvals";
import { type ExecutorApprovalDeps, ExecutorApprovals } from "../../../src/approvals/legacy/executor";

type SqlStorageOf = ConstructorParameters<typeof Approvals>[0];

function sqlOf(db: DatabaseSync): SqlStorageOf {
  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const rows = db
      .prepare(query)
      .all(...bindings)
      .map((row) => ({ ...row }));

    return { toArray: () => rows, one: () => rows[0] };
  };

  // SAFETY: B's Approvals and ExecutorApprovals call sql.exec and read toArray or one; nothing else of SqlStorage.
  return { exec, databaseSize: 0 } as SqlStorageOf;
}

export function legacyOf(db: DatabaseSync, deps: ApprovalDeps, executorDeps: ExecutorApprovalDeps) {
  const approvals = new Approvals(sqlOf(db), deps);

  return { approvals, executor: new ExecutorApprovals(sqlOf(db), approvals, executorDeps) };
}
