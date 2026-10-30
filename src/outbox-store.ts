import type { UserInput } from "@earendil-works/pi-durable";
import Type, { type Static, type TSchema } from "typebox";
import { decodeOr } from "./core/decode";
import type { ClientMessage } from "./protocol";

/**
 * What the page keeps on the device of what it has not handed to ky yet, so a page that is killed,
 * swiped away or reloaded (a lapsed sign-in, a deploy) sends it when it opens again. IndexedDB, since a
 * message's images and a clip's bytes are too big for localStorage. Where IndexedDB is missing or
 * refuses (some private windows), every call settles quietly and the page keeps what it holds in memory.
 */

/** A clip's bytes as the device kept them. */
const BlobSchema = Type.Unsafe<Blob>(Type.Object({}));

const UploadSchema = Type.Object({ file: Type.String(), body: BlobSchema, type: Type.String() });

/** A submit as the page sent it; the page never loads the Worker's schemas (src/client-messages.ts), so only its frame is checked. */
type Submit = Extract<ClientMessage, { type: "submit" }>;

const SubmitSchema = Type.Unsafe<Submit>(
  Type.Object({ type: Type.Literal("submit"), id: Type.String(), operationId: Type.String(), input: Type.Unsafe<UserInput>(Type.Any()) })
);

const StoredMessageSchema = Type.Object({
  operationId: Type.String(),
  session: Type.String(),
  message: SubmitSchema,
  at: Type.Number(),
  behind: Type.Boolean(),
  written: Type.Boolean(),
  uploads: Type.Array(UploadSchema)
});

/**
 * A message the user sent that ky has not answered: kept until the server answers or refuses it, or the user takes
 * it back. `written`: put on an open socket at least once, so ky may have it, and from then on only ky can take it
 * back. `uploads`: clips that go up before the message can.
 */
export type StoredMessage = {
  readonly operationId: string;
  /** The chat it was sent in. */
  readonly session: string;
  readonly message: Submit;
  /** When it was written. */
  readonly at: number;
  readonly behind: boolean;
  readonly written: boolean;
  readonly uploads: readonly { readonly file: string; readonly body: Blob; readonly type: string }[];
};

const StoredActSchema = Type.Object({
  id: Type.String(),
  at: Type.Number(),
  message: Type.Unsafe<ClientMessage>(Type.Object({ type: Type.String() }))
});

/** A change the user made offline, sent in order once a socket opens. */
export type StoredAct = { readonly id: string; readonly at: number; readonly message: ClientMessage };


const NAME = "ky-outbox";

const MESSAGES = "messages";

const ACTS = "acts";

let opened: Promise<IDBDatabase | null> | undefined;

function database(): Promise<IDBDatabase | null> {
  opened ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const request = indexedDB.open(NAME, 1);

      request.onupgradeneeded = () => {
        request.result.createObjectStore(MESSAGES, { keyPath: "operationId" });
        request.result.createObjectStore(ACTS, { keyPath: "id" });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return opened;
}

/**
 * Run `work` in one transaction on `store`; resolves with what the getter it returns reads once the transaction
 * commits, or with `fallback` when the device keeps nothing or the transaction fails.
 */
async function inStore<Result>(store: string, mode: IDBTransactionMode, fallback: Result, work: (objects: IDBObjectStore) => () => Result): Promise<Result> {
  const db = await database();

  if (db === null) return fallback;

  return new Promise<Result>((resolve) => {
    try {
      const transaction = db.transaction(store, mode);
      const read = work(transaction.objectStore(store));

      transaction.oncomplete = () => resolve(read());
      transaction.onerror = () => resolve(fallback);
      transaction.onabort = () => resolve(fallback);
    } catch {
      resolve(fallback);
    }
  });
}

/** Everything in `store` that reads as `schema`, oldest first; one an older page wrote differently is left out. */
function readAll<Schema extends TSchema>(store: string, schema: Schema): Promise<Array<Static<Schema>>> {
  return inStore<Array<Static<Schema>>>(store, "readonly", [], (objects) => {
    const request = objects.getAll();
    const at = (item: Static<Schema>) => decodeOr(Type.Object({ at: Type.Number() }), item, { at: 0 }).at;

    return () => request.result.flatMap((each) => decodeOr(schema, each, null) ?? []).sort((a, b) => at(a) - at(b));
  });
}

const write = (store: string, value: StoredMessage | StoredAct) =>
  inStore(store, "readwrite", undefined, (objects) => {
    objects.put(value);

    return () => undefined;
  });

const remove = (store: string, key: string) =>
  inStore(store, "readwrite", undefined, (objects) => {
    objects.delete(key);

    return () => undefined;
  });

export const messageStore = {
  /** Every message kept, oldest first. */
  all: (): Promise<StoredMessage[]> => readAll(MESSAGES, StoredMessageSchema),
  put: (message: StoredMessage) => write(MESSAGES, message),
  /** Still kept: null when this device can't say, as without IndexedDB. */
  has: (operationId: string) =>
    inStore<boolean | null>(MESSAGES, "readonly", null, (objects) => {
      const request = objects.count(operationId);

      return () => request.result > 0;
    }),
  remove: (operationId: string) => remove(MESSAGES, operationId)
};

export const actStore = {
  all: (): Promise<StoredAct[]> => readAll(ACTS, StoredActSchema),
  put: (act: StoredAct) => write(ACTS, act),
  /**
   * Take the act out to send it: true when this page took it, false when another tab did first; null when this
   * device keeps none. One transaction, so two tabs that open at once never both send it.
   */
  take: (id: string) =>
    inStore<boolean | null>(ACTS, "readwrite", null, (objects) => {
      let found = false;
      const request = objects.count(id);

      request.onsuccess = () => {
        found = request.result > 0;

        if (found) objects.delete(id);
      };

      return () => found;
    })
};

/** Tells the page's other tabs that a message is gone, answered or taken back, so none shows it or sends it again. */
export type OutboxChannel = { readonly gone: (operationId: string) => void; readonly close: () => void };

export function outboxChannel(onGone: (operationId: string) => void): OutboxChannel {
  try {
    const channel = new BroadcastChannel(NAME);

    channel.onmessage = (event: MessageEvent<unknown>) => {
      const operationId = decodeOr(Type.String(), event.data, null);

      if (operationId !== null) onGone(operationId);
    };

    return { gone: (operationId) => channel.postMessage(operationId), close: () => channel.close() };
  } catch {
    return { gone: () => {}, close: () => {} };
  }
}
