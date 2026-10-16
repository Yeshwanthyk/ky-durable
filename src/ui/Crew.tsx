import { useEffect, useRef, useState } from "react";
import { BotAvatar } from "./BotAvatar";
import { type Crew, type CrewFace, NO_CREW } from "./crew-of";

/** How long the crew stays after its last answer lands, so the landing shows. */
const LINGER_MS = 2_400;

/** How far over a face looks at a neighbour, and a touch up. */
const SIDEWAYS: readonly [number, number] = [0.9, -0.1];

/**
 * The crew the pill shows: the one working, then the one that just finished, for a moment, as it
 * was when its work ended. Another chat's crew never lingers into this one.
 */
export function useShownCrew(crew: Crew, session: string): Crew {
  const working = crew.working > 0;
  const latest = useRef(crew);
  latest.current = crew;
  const seen = useRef({ working, session });
  const [held, setHeld] = useState<Crew | null>(null);

  useEffect(() => {
    const was = seen.current;
    seen.current = { working, session };

    if (working || !was.working || was.session !== session) {
      setHeld(null);

      return;
    }

    setHeld(latest.current);
    const timer = setTimeout(() => setHeld(null), LINGER_MS);

    return () => clearTimeout(timer);
  }, [working, session]);

  return working ? crew : (held ?? NO_CREW);
}

/** Who the row looks at: the first one working, else the first face. Index 0 is ky. */
function focusOf(faces: readonly CrewFace[]): number {
  const working = faces.findIndex((face) => face.state === "working");

  return (working === -1 ? 0 : working) + 1;
}

/** Where the face at `index` looks: at the focus, sideways; null to let it look where its mood says. */
export function gazeOf(index: number, focus: number): readonly [number, number] | null {
  if (index === focus) return null;

  return [Math.sign(focus - index) * SIDEWAYS[0], SIDEWAYS[1]];
}

/** A count per face that grows each time its work lands well, which makes it hop with a heart. */
function useCheers(faces: readonly CrewFace[]): ReadonlyMap<string, number> {
  const before = useRef(new Map<string, CrewFace["state"]>());
  const [cheers, setCheers] = useState<ReadonlyMap<string, number>>(new Map());

  useEffect(() => {
    const landed = faces.filter((face) => before.current.get(face.id) === "working" && face.state === "idle");
    before.current = new Map(faces.map((face) => [face.id, face.state]));

    if (landed.length === 0) return;

    setCheers((current) => {
      const next = new Map(current);

      for (const face of landed) next.set(face.id, (next.get(face.id) ?? 0) + 1);

      return next;
    });
  }, [faces]);

  return cheers;
}

/** The specialists sat beside ky, each watching whoever works. */
export function CrewRow({ faces }: { faces: readonly CrewFace[] }) {
  const cheers = useCheers(faces);
  const focus = focusOf(faces);

  if (faces.length === 0) return null;

  return (
    <span className="crew" aria-hidden>
      {faces.map((face, index) => (
        <span key={face.id} className="crew-face" data-state={face.state}>
          <BotAvatar
            name={`@${face.id}`}
            identity={face.id}
            owner={face.id}
            active={face.state === "working"}
            failed={face.state === "failed"}
            gaze={face.state === "idle" ? gazeOf(index + 1, focus) : null}
            cheer={cheers.get(face.id) ?? 0}
            size={24}
          />
        </span>
      ))}
    </span>
  );
}

/** Where ky looks while a crew works: at whoever the row watches. */
export const kyGaze = (crew: Crew) => (crew.faces.length === 0 ? null : gazeOf(0, focusOf(crew.faces)));

/** How many of a group chat's members answer, while any do. */
export function CrewCount({ crew }: { crew: Crew }) {
  if (crew.members === 0 || crew.working === 0) return null;

  return (
    <span className="crew-count">
      {crew.working}/{crew.members}
    </span>
  );
}

/** What the crew adds to the pill's label for a screen reader. */
export const crewSays = (crew: Crew) => (crew.line === null ? "" : ` ${crew.line}.`);
