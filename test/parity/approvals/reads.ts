import type { Approval, ApprovalHandler } from "../../../src/approvals/approvals";
import type { ApprovalAction, ApprovalKind } from "../../../src/approvals/contract";
import type { ExecutorApprovals } from "../../../src/approvals/executor";

type Side = {
  readonly approvals: {
    handle(kind: ApprovalKind, handler: ApprovalHandler): void;
    get(id: string): Approval | undefined;
    byRef(kind: ApprovalKind, ref: string): Approval | undefined;
    pending(): unknown[];
    recover(): void;
  };
  readonly executor: Pick<ExecutorApprovals, "policies" | "policyFor" | "beforeResume">;
};

const KINDS: ApprovalKind[] = ["executor", "webhook-action", "secret-request"];

const TOOLS = ["gmail.send", "calendar.read", "drive.delete", "none"];

const REFS: ReadonlyArray<readonly [ApprovalKind, string]> = [
  ["executor", "r1"],
  ["executor", "r2"],
  ["executor", "r3"],
  ["executor", "r4"],
  ["executor", "r5"],
  ["webhook-action", "w1"],
  ["webhook-action", "w2"],
  ["secret-request", "s1"],
  ["executor", "none"]
];

export function readsOf(side: Side) {
  const lost: Array<{ readonly approval: Approval; readonly action: ApprovalAction }> = [];

  for (const kind of KINDS) {
    side.approvals.handle(kind, {
      decide: async () => {},
      lost: async (approval, action) => void lost.push({ approval, action })
    });
  }

  const shown = (approval: Approval | undefined) => (approval ? { ...approval, payload: approval.payload ?? null } : null);
  const byRef = () => REFS.map(([kind, ref]) => shown(side.approvals.byRef(kind, ref)));
  const before = byRef();

  return {
    byRef: before,
    get: before.map((approval) => shown(side.approvals.get(approval?.id ?? "none"))),
    pending: side.approvals.pending(),
    policies: side.executor.policies(),
    policyFor: TOOLS.map((tool) => side.executor.policyFor(tool)),
    beforeResume: [
      side.executor.beforeResume("in1", "answer", "here"),
      side.executor.beforeResume("in1", "answer", "away"),
      side.executor.beforeResume("r1", "answer", "here"),
      side.executor.beforeResume("r1", "answer", "away")
    ].map((said) => said ?? null),
    recovered: (() => {
      side.approvals.recover();

      return { lost, byRef: byRef() };
    })()
  };
}
