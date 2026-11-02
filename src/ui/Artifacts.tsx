import { type FormEvent, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Type from "typebox";
import { parseOr } from "../core/decode";
import type { FileRow } from "../files/contract";
import { FilesContext, isMedia } from "./Attachments";
import { CopyButton } from "./CopyButton";
import { Icon } from "../chat-kit/Icon";
import { type Media, useLightbox } from "./Lightbox";
import { VoiceNote } from "./Media";
import { day } from "./time";
import { useDismiss } from "./use-dismiss";
import type { ArtifactKind } from "./use-session-route";

/**
 * Everything ky made, in one place: the screenshots, videos and sounds tasks attached (src/files.ts), and the
 * sites it published (src/sites.ts), newest first, a row each with a small preview. Pictures and videos open in
 * the lightbox, a sound plays in its row and saves to the device, and a site opens in a new tab; a site's share
 * links open from its "…" menu.
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

  if (artifact.kind === "sites") return <SiteRow site={artifact.site} meta={meta} />;

  const { file } = artifact;
  const src = `/files/${file.id}`;
  const title = file.caption ?? file.name;
  const made = from ? `${meta} · ${from}` : meta;

  if (artifact.kind === "audio") return <SoundCard src={src} title={title} name={file.name} meta={made} />;

  return <VisualCard src={src} title={title} meta={made} video={artifact.kind === "videos"} onView={() => onView(src)} />;
}

const Links = Type.Object({
  links: Type.Array(Type.Object({ token: Type.String(), label: Type.String(), mode: Type.Union([Type.Literal("view"), Type.Literal("edit")]), created: Type.Number() }))
});

type Link = Type.Static<typeof Links>["links"][number];

const Refused = Type.Object({ error: Type.String() });

/** What a refused link change says; null when it went through. */
async function refusalOf(response: Response | null): Promise<string | null> {
  if (response?.ok) return null;
  const text = response ? await response.text().catch(() => "") : "";

  return parseOr(Refused, text, { error: "ky couldn't reach the site's links." }).error;
}

function LinkItem({ link, base, onDone }: { link: Link; base: string; onDone: (response: Response | null) => void }) {
  const named = link.label || "Link";

  return (
    <li data-link={link.token}>
      <a href={`/p/${link.token}/`} target="_blank" rel="noreferrer">
        {named}
      </a>
      <span className="artifact-badge">{link.mode === "edit" ? "Can edit" : "View only"}</span>
      <CopyButton text={`${location.origin}/p/${link.token}/`} label={`Copy ${link.label || "the"} link`} />
      <button type="button" className="automation-text pressable" onClick={() => void fetch(`${base}/${link.token}`, { method: "DELETE" }).catch(() => null).then(onDone)}>
        Revoke
      </button>
    </li>
  );
}

function LinkForm({ title, onMake }: { title: string; onMake: (label: string, mode: "view" | "edit") => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"view" | "edit">("view");

  const make = async (event: FormEvent) => {
    event.preventDefault();
    await onMake(label, mode);
    setLabel("");
  };

  return (
    <form className="artifact-link-form" aria-label={`Share ${title}`} onSubmit={(event) => void make(event)}>
      <input className="field-input" value={label} placeholder="Who it's for" maxLength={80} aria-label="Who it's for" onChange={(event) => setLabel(event.currentTarget.value)} />
      <select className="field-select" value={mode} aria-label="What they can do" onChange={(event) => setMode(event.currentTarget.value === "edit" ? "edit" : "view")}>
        <option value="view">View only</option>
        <option value="edit">Can edit</option>
      </select>
      <button type="submit" className="pill primary pressable">
        Make link
      </button>
    </form>
  );
}

function LinkList({ links, base, onDone }: { links: readonly Link[] | null; base: string; onDone: (response: Response | null) => void }) {
  if (links === null) return <p className="field-hint">Loading…</p>;

  return (
    <>
      {links.length === 0 ? <p className="field-hint">No links: only you can open it.</p> : null}
      <ul className="artifact-link-list">
        {links.map((link) => (
          <LinkItem key={link.token} link={link} base={base} onDone={onDone} />
        ))}
      </ul>
    </>
  );
}

/** A site's row: the page it opens, its "…" menu, and under it the share links once the menu opens them. */
function SiteRow({ site, meta }: { site: Site; meta: string }) {
  const [sharing, setSharing] = useState(false);

  return (
    <>
      <div className="artifact">
        <a className="artifact-open pressable" href={`/s/${site.id}/`} target="_blank" rel="noreferrer" aria-label={`Open ${site.title}`}>
          <div className="artifact-preview artifact-site">
            <iframe src={`/s/${site.id}/`} title={site.title} loading="lazy" sandbox="" tabIndex={-1} aria-hidden onLoad={drawn} />
          </div>
          <Footer title={site.title} meta={meta} badge={site.public ? "Public" : undefined} />
        </a>
        <MoreMenu title={site.title} sharing={sharing} onShare={() => setSharing(!sharing)} />
      </div>
      {sharing ? <SiteLinks site={site} onClose={() => setSharing(false)} /> : null}
    </>
  );
}

/** A row's "…": a small menu, for now holding a site's share links. It closes on a click outside or Escape. */
function MoreMenu({ title, sharing, onShare }: { title: string; sharing: boolean; onShare: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, root, close);

  return (
    <div className="artifact-more" ref={root}>
      <button type="button" className="icon-button pressable" aria-label={`More for ${title}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" size={16} />
      </button>
      {open ? (
        <div className="group-menu artifact-menu" role="menu" aria-label={`More for ${title}`}>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={sharing}
            className="group-option pressable"
            onClick={() => {
              setOpen(false);
              onShare();
            }}
          >
            Share links
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A site's share links: each opens it at /p/<token>/, a view link only reading its data, an edit link writing it too; made and revoked here. */
function SiteLinks({ site, onClose }: { site: Site; onClose: () => void }) {
  const [links, setLinks] = useState<readonly Link[] | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const base = `/api/sites/${site.id}/links`;

  const load = async () => {
    const response = await fetch(base).catch(() => null);
    setLinks(response?.ok ? parseOr(Links, await response.text(), { links: [] }).links : []);
  };

  const said = async (response: Response | null) => {
    setRefused(await refusalOf(response));
    await load();
  };

  const make = async (label: string, mode: "view" | "edit") => said(await fetch(base, { method: "POST", body: JSON.stringify({ label, mode }) }).catch(() => null));

  useEffect(() => {
    void load();
    // Loaded once, when the menu opens the links; changes reload them through said.
  }, []);

  return (
    <section className="artifact-links" aria-label={`Share links for ${site.title}`}>
      <header className="artifact-links-head">
        <h3>Share links</h3>
        <button type="button" className="icon-button pressable" aria-label="Close share links" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <LinkList links={links} base={base} onDone={(response) => void said(response)} />
      <LinkForm title={site.title} onMake={make} />
      {refused ? <p className="field-hint">{refused}</p> : null}
    </section>
  );
}

function SoundCard({ src, title, name, meta }: { src: string; title: string; name: string; meta: string }) {
  return (
    <div className="artifact">
      <div className="artifact-preview artifact-sound" aria-hidden>
        <Icon name="mic" size={18} />
      </div>
      <Footer title={title} meta={meta} />
      <VoiceNote src={src} seconds={null} peaks={null} label={title} name={name} />
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
      <Footer title={title} meta={meta} />
    </button>
  );
}

function Footer({ title, meta, badge }: { title: string; meta: string; badge?: string | undefined }) {
  return (
    <div className="artifact-foot">
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
