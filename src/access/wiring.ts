import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import { makeEdge } from "../core/edge";
import { isRefusal } from "../core/refusal";
import { type AccessVars, type CertsFetch, Keys, signedIn } from "./access";
import { SIGN_IN, TRY_AGAIN } from "./contract";

const status = (refused: string) => (refused === SIGN_IN ? 401 : refused === TRY_AGAIN ? 503 : 500);

export class Access {
  readonly #edge;

  constructor(certs: CertsFetch = (url) => fetch(url), clock?: Clock.Clock) {
    const keys = Keys.layer(certs);
    this.#edge = makeEdge(clock ? Layer.provideMerge(keys, Layer.succeed(Clock.Clock)(clock)) : keys);
  }

  async refuse(request: Request, env: AccessVars): Promise<Response | undefined> {
    const result = await this.#edge.runPromise(signedIn(request, env));

    return isRefusal(result) ? new Response(result.refused, { status: status(result.refused) }) : undefined;
  }
}
