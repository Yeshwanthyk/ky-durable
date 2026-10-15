import type { Extension } from "@earendil-works/pi-durable";
import type { Models } from "../models";
import type { GroupDesk } from "./group";
import { type PeerDesk, peerExtension } from "./peers";

/** What the agent (src/server.ts) and its sockets run: the peers domain's classes and routes. */
export { GroupChats, GroupDesk } from "./group";

export { deliver, peerAnswer, PeerAsks, type PeerDesk, peerInvite, peerList, peerPair, peerQuestion, peerRemove, peerRoute, Peers, sweepPeers } from "./peers";

/** What the peers domain's tools are made from, on the agent (src/server.ts). */
export type PeersWiring = {
  readonly group: GroupDesk;
  readonly peerDesk: PeerDesk;
  readonly models: Models;
  /** The main chat or a side chat. */
  readonly chat: (session: string) => boolean;
};

/**
 * A specialist's seat in a chat, which goes without `remove`, and the peer tool. Making the seat
 * defines the group desk's reply task, so it is made once pi opens.
 */
export function peerTools({ group, peerDesk, models, chat }: PeersWiring, remove: readonly Extension[]) {
  return {
    seat: group.extension({ remove, model: (own) => models.worker(own) }).extension,
    peer: peerExtension(peerDesk, chat)
  };
}
