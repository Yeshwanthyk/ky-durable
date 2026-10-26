type ChatReads = {
  list(): ReadonlyArray<object>;
  mainUpdatedAt(): number;
  has(session: string): boolean;
  openedFor(request: string): string | undefined;
  openedBy(session: string): string | null;
};

export const SESSIONS = ["2", "3", "4", "5", "6", "9"];

export const REQUESTS = ["chat-create:1:7", "chat-create:3:1", "chat-create:1:8", "none"];

export function readsOf(chats: ChatReads) {
  return {
    list: chats.list(),
    main: chats.mainUpdatedAt(),
    has: SESSIONS.map((session) => chats.has(session)),
    openedFor: REQUESTS.map((request) => chats.openedFor(request) ?? null),
    openedBy: SESSIONS.map((session) => chats.openedBy(session))
  };
}
