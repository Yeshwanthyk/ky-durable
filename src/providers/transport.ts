import type { Api, ApiStreamOptions, Model, StreamOptions } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";

export function sending(provider: Provider, options: (given: StreamOptions | undefined) => StreamOptions): Provider {
  return {
    ...provider,
    stream: <T extends Api>(model: Model<T>, context: Parameters<Provider["stream"]>[1], given?: ApiStreamOptions<T>) =>
      // SAFETY: every API's options extend StreamOptions, and the overlay sets only StreamOptions' fields.
      provider.stream(model, context, { ...given, ...options(given) } as ApiStreamOptions<T>),
    streamSimple: (model, context, given) => provider.streamSimple(model, context, { ...given, ...options(given) })
  };
}
