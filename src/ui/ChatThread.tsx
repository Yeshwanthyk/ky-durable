import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { PiSessionView } from "../view";
import { Thread } from "./Thread";
import { buildTurns } from "./turns";

type ThreadView = Pick<PiSessionView, "messages" | "live" | "running" | "tools">;

const isEmpty = ({ messages, live, running }: ThreadView) => messages.length === 0 && !live && !running;

// The open chat's thread, kept scrolled to the end; `welcome` stands in while it is empty.
export function ChatThread({
  view,
  welcome,
}: {
  view: ThreadView;
  welcome: ReactNode;
}) {
  const { messages, live, running, tools } = view;
  const endRef = useRef<HTMLDivElement>(null);
  const turns = useMemo(() => buildTurns(messages, live, running, tools), [messages, live, running, tools]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, running]);

  return (
    <main className="thread" data-scroll>
      <div className="thread-inner">
        {isEmpty(view) ? welcome : <Thread turns={turns} mode={running ? "live" : "dormant"} />}
        <div ref={endRef} />
      </div>
    </main>
  );
}
