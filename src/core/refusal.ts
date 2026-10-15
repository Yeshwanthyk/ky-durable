/** Why ky won't do what was asked, in words for the user: the one refusal shape every module returns. */
export type Refusal = { readonly refused: string };

/** What was asked for, or why ky won't do it. */
export type Result<T extends object> = T | Refusal;

export function refused(refused: string): Refusal {
  return { refused };
}

export function isRefusal<T extends object>(result: Result<T>): result is Refusal {
  return "refused" in result;
}
