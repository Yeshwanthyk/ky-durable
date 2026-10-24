import { useContext, useEffect, useMemo, useState } from "react";
import Type from "typebox";
import { parseOr } from "../core/decode";
import type { FileRow } from "../files";
import { FilesContext, isMedia } from "./Attachments";
import { Icon } from "./Icon";
import { type Media, useLightbox } from "./Lightbox";
import { VoiceNote } from "./Media";
import { day } from "./time";
import type { ArtifactKind } from "./use-session-route";

/**
 * Everything ky made, in one place: the screenshots, videos and sounds tasks attached (src/files.ts), and the
 * sites it published (src/sites.ts), newest first. Pictures and videos open in the lightbox, a sound plays in
 * its card and saves to the device, and a site opens in a new tab.
 */

const Sites = Type.Array(Type.Object({ id: Type.String({ pattern: "^[0-9a-f]{32}$" }), title: Type.String(), created: Type.Number(), public: Type.Boolean() }));

type Site = Type.Static<typeof Sites>[number];

type Artifact =
  | { readonly kind: "sites"; readonly key: string; readonly at: number; readonly site: Site }
  | { readonly kind: "images" | "videos" | "audio"; readonly key: string; readonly at: number; readonly file: FileRow };

const TABS: ReadonlyArray<readonly [ArtifactKind, string]> = [
  ["all", "All"],
  ["sites", "Sites"],
  ["images", "Images"],
  ["videos", "Videos"],
  ["audio", "Audio"]
];

const NOUN: Record<Artifact["kind"], string> = { sites: "Site", images: "Image", videos: "Video", audio: "Audio" };

const EMPTY: Record<ArtifactKind, string> = {
  all: "Nothing yet. What ky makes for you, pictures, videos, sounds and sites, gathers here.",
  sites: "No sites yet. Ask ky to make you a page.",
  images: "No images yet.",
  videos: "No videos yet.",
  audio: "No audio yet."
};

/** Marks a preview drawn, so it fades in rather than flashing white over the card. */
const drawn = (event: { currentTarget: HTMLElement }) => {
  event.currentTarget.dataset.loaded = "";
};

const kindOf = (file: FileRow): "images" | "videos" | "audio" =>
  file.type.startsWith("audio/") ? "audio" : file.type.startsWith("video/") ? "videos" : "images";

/** The sites, or null while they load; an empty list when they can't. */
function useSites(): readonly Site[] | null {
  const [sites, setSites] = useState<readonly Site[] | null>(null);

  useEffect(() => {
    let live = true;

    void fetch("/api/sites")
      .then((response) => (response.ok ? response.text() : "[]"))
      .catch(() => "[]")
      .then((text) => live && setSites(parseOr(Sites, text, [])));

    return () => {
      live = false;
    };
  }, []);

  return sites;
}

export function Artifacts({
  kind,
  titles,
  now,
  onKind,
  onChats
}: {
  kind: ArtifactKind;
  /** Each task's title by its id, to say what made a file. */
  titles: ReadonlyMap<string, string>;
  now: number;
  onKind: (kind: ArtifactKind) => void;
  /** Opens the chats drawer, below the wide layout. */
  onChats: () => void;
}) {
  const files = useContext(FilesContext);
  const sites = useSites();
  const open = useLightbox();

  const all = useMemo(() => {
    const made: Artifact[] = [
      ...files.filter(isMedia).map((file) => ({ kind: kindOf(file), key: file.id, at: file.created_at, file })),
      ...(sites ?? []).map((site) => ({ kind: "sites" as const, key: site.id, at: site.created, site }))
    ];

    return made.sort((a, b) => b.at - a.at);
  }, [files, sites]);

  const shown = kind === "all" ? all : all.filter((artifact) => artifact.kind === kind);

  // The lightbox steps through the pictures and videos shown, in their order here.
  const viewable = shown.flatMap((artifact): Media[] =>
    artifact.kind === "images" || artifact.kind === "videos"
      ? [{ src: `/files/${artifact.file.id}`, label: artifact.file.caption ?? artifact.file.name, video: artifact.kind === "videos" }]
      : []
  );

  const view = (src: string) =>
    open(
      viewable,
      viewable.findIndex((item) => item.src === src)
    );

  return (
    <section className="stage artifacts" aria-label="Artifacts">
      <header className="artifacts-head">
        <button type="button" className="icon-button pressable drawer-toggle" aria-label="Chats" onClick={onChats}>
          <Icon name="menu" size={18} />
        </button>
        <h1>Artifacts</h1>
      </header>
      <div className="artifacts-tabs" role="tablist" aria-label="Kinds">
        {TABS.map(([value, label]) => (
          <button key={value} type="button" role="tab" className="pressable" aria-selected={value === kind} onClick={() => onKind(value)}>
            {label}
          </button>
        ))}
      </div>
      <div className="artifacts-body" data-scroll>
        {shown.length === 0 ? (
          <p className="artifacts-empty">{sites === null && (kind === "all" || kind === "sites") ? "Loading…" : EMPTY[kind]}</p>
        ) : (
          <ul className="artifact-grid">
            {shown.map((artifact) => (
              <li key={artifact.key}>
                <Card artifact={artifact} from={artifact.kind === "sites" ? undefined : titles.get(artifact.file.task)} now={now} onView={view} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Card({
  artifact,
  from,
  now,
  onView
}: {
  artifact: Artifact;
  from: string | undefined;
  now: number;
  onView: (src: string) => void;
}) {
  const meta = [NOUN[artifact.kind], day(artifact.at, now)].join(" · ");

  if (artifact.kind === "sites") {
    const { site } = artifact;

    return (
      <a className="artifact pressable" href={`/s/${site.id}/`} target="_blank" rel="noreferrer" aria-label={`Open ${site.title}`}>
        <div className="artifact-preview artifact-site">
          <iframe src={`/s/${site.id}/`} title={site.title} loading="lazy" sandbox="" tabIndex={-1} aria-hidden onLoad={drawn} />
        </div>
        <Footer title={site.title} meta={meta} icon="globe" badge={site.public ? "Public" : undefined} />
      </a>
    );
  }

  const { file } = artifact;
  const src = `/files/${file.id}`;
  const title = file.caption ?? file.name;
  const made = from ? `${meta} · ${from}` : meta;

  if (artifact.kind === "audio") return <SoundCard src={src} title={title} name={file.name} meta={made} />;

  return <VisualCard src={src} title={title} meta={made} video={artifact.kind === "videos"} onView={() => onView(src)} />;
}

function SoundCard({ src, title, name, meta }: { src: string; title: string; name: string; meta: string }) {
  return (
    <div className="artifact">
      <div className="artifact-preview artifact-sound">
        <VoiceNote src={src} seconds={null} peaks={null} label={title} name={name} />
      </div>
      <Footer title={title} meta={meta} icon="mic" />
    </div>
  );
}

function VisualCard({ src, title, meta, video, onView }: { src: string; title: string; meta: string; video: boolean; onView: () => void }) {
  return (
    <button type="button" className="artifact pressable" aria-label={`Open ${title}`} onClick={onView}>
      <div className="artifact-preview">
        {video ? (
          <>
            <video
              src={src}
              muted
              playsInline
              preload="metadata"
              onError={drawn}
              onLoadedMetadata={drawn}
            />
            <span className="artifact-play" aria-hidden>
              <Icon name="play" size={14} />
            </span>
          </>
        ) : (
          <img src={src} alt="" loading="lazy" onLoad={drawn} onError={drawn} />
        )}
      </div>
      <Footer title={title} meta={meta} icon={video ? "play" : "image"} />
    </button>
  );
}

function Footer({ title, meta, icon, badge }: { title: string; meta: string; icon: "globe" | "mic" | "play" | "image"; badge?: string | undefined }) {
  return (
    <div className="artifact-foot">
      <span className="artifact-icon" aria-hidden>
        <Icon name={icon} size={14} />
      </span>
      <span className="artifact-text">
        <span className="artifact-title">
          {title}
          {badge ? <span className="artifact-badge">{badge}</span> : null}
        </span>
        <span className="artifact-meta">{meta}</span>
      </span>
    </div>
  );
}
