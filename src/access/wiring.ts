import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEdge } from "../core/edge";
import { type CertsFetch, Keys, type KeysCell, signedIn } from "./access";
import type { AccessVars, KeysUnavailable, NotSetUp, SignInRefused } from "./contract";

type Refused = SignInRefused | NotSetUp | KeysUnavailable;

const STATUS: Record<Refused["_tag"], number> = { SignInRefused: 401, NotSetUp: 500, KeysUnavailable: 503 };

export class Access {
  readonly #layer;

  constructor(certs: CertsFetch = (url) => fetch(url), clock?: Clock.Clock) {
    const keys = Keys.layer(certs, {} satisfies KeysCell);
    this.#layer = clock ? Layer.provideMerge(keys, Layer.succeed(Clock.Clock)(clock)) : keys;
  }

  async refuse(request: Request, env: AccessVars): Promise<Response | undefined> {
    const edge = makeEdge(this.#layer);

    try {
      return await edge.runPromise(
        signedIn(request, env).pipe(
          Effect.match({ onSuccess: () => undefined, onFailure: (refused: Refused) => new Response(refused.refusal, { status: STATUS[refused._tag] }) })
        )
      );
    } finally {
      await edge.dispose();
    }
  }
}
