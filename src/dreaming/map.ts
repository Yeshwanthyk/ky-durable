import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Static } from "typebox";
import { type Edge, makeEdge } from "../core/edge";
import { toolReply as text } from "../core/reply";
import { Sql } from "../core/sql";

const MAP_TOOL = "work_map";

const MapState = Schema.Literals(["open", "doing", "waiting", "done"]);

export type MapState = typeof MapState.Type;

/** Items kept open at once; the dream folds or closes before adding past it. */
const MAP_OPEN = 30;

const TITLE_CHARS = 120;

const NEXT_CHARS = 300;

const MapItem = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  state: MapState,
  next: Schema.String,
  by: Schema.String,
  updated_at: Schema.Number,
  updated_by: Schema.String
});

export type MapItem = typeof MapItem.Type;

const decodeItem = Schema.decodeUnknownOption(MapItem);

/** Whether an item may move `from` one state `to` another: any move but out of done (invariant 8). */
export const canMove = (from: MapState, to: MapState): boolean => from !== "done" && from !== to;

/** One line per item, as the looks and the dream read it. */
export const mapLine = (item: MapItem): string => `- map:${item.id} [${item.state}] ${item.title}${item.next === "" ? "" : ` — next: ${item.next}`}${item.by === "" ? "" : ` (by ${item.by})`}`;

export type MapAnswer = MapItem | { readonly refused: string };

class MapStore extends Context.Service<
  MapStore,
  {
    readonly open: Effect.Effect<MapItem[]>;
    readonly get: (id: number) => Effect.Effect<MapItem | undefined>;
    readonly add: (title: string, next: string, by: string, who: string, at: number) => Effect.Effect<MapAnswer>;
    readonly move: (id: number, to: MapState, next: string | undefined, who: string, at: number) => Effect.Effect<MapAnswer>;
  }
>()("ky/dreaming/WorkMap") {
  static readonly layer = Layer.effect(
    MapStore,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const items = (query: string, ...params: SqlStorageValue[]) => Effect.map(exec(query, ...params), (rows) => rows.flatMap((row) => Option.toArray(decodeItem(row))));

      yield* exec(`CREATE TABLE IF NOT EXISTS ky_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'doing', 'waiting', 'done')),
        next TEXT NOT NULL DEFAULT '',
        by TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL)`);

      const COLUMNS = "id, title, state, next, by, updated_at, updated_by";
      const get = (id: number) => Effect.map(items(`SELECT ${COLUMNS} FROM ky_map WHERE id = ?`, id), ([item]) => item);
      const open = items(`SELECT ${COLUMNS} FROM ky_map WHERE state != 'done' ORDER BY updated_at DESC, id DESC`);

      return MapStore.of({
        open,
        get,
        add: Effect.fn("WorkMap.add")(function* (title, next, by, who, at) {
          const trimmed = title.trim();

          if (trimmed === "") return { refused: "An item needs a title." };

          if ((yield* open).length >= MAP_OPEN) return { refused: `The map holds ${MAP_OPEN} open items: close or fold one first.` };

          const [row] = yield* exec(
            "INSERT INTO ky_map (title, state, next, by, updated_at, updated_by) VALUES (?, 'open', ?, ?, ?, ?) RETURNING id",
            trimmed.slice(0, TITLE_CHARS),
            next.trim().slice(0, NEXT_CHARS),
            by.trim(),
            at,
            who
          );

          return (yield* get(Number(row?.id))) ?? { refused: "The item was not kept." };
        }),
        move: Effect.fn("WorkMap.move")(function* (id, to, next, who, at) {
          const item = yield* get(id);

          if (item === undefined) return { refused: `No map item #${id}.` };

          if (!canMove(item.state, to) && !(item.state === to && next !== undefined && to !== "done")) {
            return { refused: item.state === "done" ? `#${id} is done; add a new item instead.` : `#${id} is ${to} already.` };
          }

          // Guarded on the state read, so a move another writer made first is not overwritten.
          yield* exec("UPDATE ky_map SET state = ?, next = ?, updated_at = ?, updated_by = ? WHERE id = ? AND state = ?", to, (next ?? item.next).trim().slice(0, NEXT_CHARS), at, who, id, item.state);

          return (yield* get(id)) ?? { refused: `No map item #${id}.` };
        })
      });
    })
  );
}

export class WorkMap {
  readonly #edge: Edge<MapStore>;

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(MapStore.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  open(): MapItem[] {
    return this.#edge.run(MapStore.use((store) => store.open));
  }

  add(title: string, next: string, by: string, who: string, at = Date.now()): MapAnswer {
    return this.#edge.run(MapStore.use((store) => store.add(title, next, by, who, at)));
  }

  move(id: number, to: MapState, next: string | undefined, who: string, at = Date.now()): MapAnswer {
    return this.#edge.run(MapStore.use((store) => store.move(id, to, next, who, at)));
  }

}

const MapInput = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("move")]),
  id: Type.Optional(Type.Integer({ description: "The item, for move." })),
  title: Type.Optional(Type.String({ description: `For add: what the user is working toward, one line, at most ${TITLE_CHARS} characters.` })),
  state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("doing"), Type.Literal("waiting"), Type.Literal("done")])),
  next: Type.Optional(Type.String({ description: "The next concrete step, or what it waits on." })),
  by: Type.Optional(Type.String({ description: "When it is due, ISO 8601, if it has a date." }))
});

const listReply = (open: readonly MapItem[]) => text(open.length === 0 ? "The map is empty." : open.map(mapLine).join("\n"));

const reply = (answer: MapAnswer) => text("refused" in answer ? answer.refused : mapLine(answer));

function change(map: WorkMap, args: Static<typeof MapInput>, who: string) {
  if (args.action === "add") return reply(map.add(args.title ?? "", args.next ?? "", args.by ?? "", who));

  if (args.id === undefined || args.state === undefined) return text("move needs an id and a state.");

  return reply(map.move(args.id, args.state, args.next, who));
}

/** The work map, for the main chat, side chats, the dream and the looks (a look may only list). */
export function mapTool(map: WorkMap, who: (session: string) => string, listOnly: (session: string) => boolean) {
  return defineTool({
    name: MAP_TOOL,
    description:
      "The user's work map: the things they are working toward (a launch, a move, a hiring round), each open, doing, waiting or done, with its next step. list shows the open ones. add takes a title, and a next step and a date when known. move sets an item's state, and its next step. Done is final. Keep it to what the user said they are working on; not every task is an item.",
    parameters: MapInput,
    replay: "unsafe",
    execute: async (args, api) => {
      const session = String(api.conversationId);

      if (args.action === "list" || listOnly(session)) return listReply(map.open());

      return change(map, args, who(session));
    }
  });
}
