type Device = { readonly endpoint: string; readonly p256dh: string; readonly auth: string };

type Side = {
  subscribe(device: Device): void;
  unsubscribe(endpoint: string): void;
  notify(session: string, text: string): Promise<void>;
};

export type Answers = { status: (endpoint: string) => number; readonly tried: string[] };

export const ROWS = ["SELECT * FROM ky_push_devices ORDER BY endpoint", "SELECT * FROM ky_push_sent ORDER BY day"] as const;

export function answering(): Answers {
  return { status: () => 201, tried: [] };
}

export async function readsOf<Rows>(side: Side, answers: Answers, rows: () => Rows, again: Device) {
  const rounds: { readonly tried: string[]; readonly rows: Rows }[] = [];

  for (const status of [201, 410, 201, 201]) {
    const from = answers.tried.length;
    answers.status = (endpoint) => (endpoint.endsWith("/b") ? status : 201);
    await side.notify("1", `read ${rounds.length}`);
    rounds.push({ tried: answers.tried.slice(from).sort(), rows: rows() });
  }

  side.subscribe(again);
  side.unsubscribe("https://fcm.test/send/c");

  return { rounds, after: rows() };
}
