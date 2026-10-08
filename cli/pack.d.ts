/** Bun embeds a file imported `with { type: "file" }` in a compiled binary and gives its path. */
declare module "*.pack" {
  const path: string;
  export default path;
}
