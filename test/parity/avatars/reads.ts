type Side = {
  readonly avatars: { all(): object };
  readonly setup: { view(): object; selfEdit(): object | undefined; origin(): string | null; firstStart(): boolean };
};

export function readsOf({ avatars, setup }: Side) {
  return { avatars: avatars.all(), setup: setup.view(), selfEdit: setup.selfEdit() ?? null, origin: setup.origin(), firstStart: setup.firstStart() };
}
