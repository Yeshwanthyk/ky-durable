/**
 * The local stack's Worker as `vite build` bundles it (test/stack/vite.config.ts with KY_STACK_OUT): its handler
 * and classes only. workerd takes every export of a built Worker as an entrypoint, and src/tests/stack.ts also
 * exports the constants the tests share with it.
 */
export { CloudMachine, default, GithubProxy, PiAgent, Vault } from "./stack";
