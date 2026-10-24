import { type PointerEvent, useEffect, useRef, useState } from "react";
import { clock, type MediaClip, PEAK_BARS } from "../media";
import { Icon } from "./Icon";

/** A clip's loudness as bars of 0–1, from its peaks; a clip without them gets an even, quiet row. */
const barsOf = (peaks: string | null) =>
  peaks === null ? Array.from({ length: PEAK_BARS }, () => 0.25) : Array.from(peaks, (digit) => (Number(digit) + 1) / 10);

/**
 * Loudness over a clip's length from its decoded samples: the loudest sample in each of PEAK_BARS stretches,
 * scaled to the loudest stretch, one digit each.
 */
export function peaksFrom(samples: Float32Array): string {
  const size = Math.max(1, Math.floor(samples.length / PEAK_BARS));
  const loudest: number[] = [];

  for (let bar = 0; bar < PEAK_BARS; bar++) {
    let peak = 0;

    for (let at = bar * size; at < Math.min(samples.length, (bar + 1) * size); at++) peak = Math.max(peak, Math.abs(samples[at] ?? 0));
    loudest.push(peak);
  }

  return digits(loudest);
}

/** Levels of any scale as PEAK_BARS digits, resampled and scaled to the loudest. */
export function digits(levels: readonly number[]): string {
  if (levels.length === 0) return "0".repeat(PEAK_BARS);
  const top = Math.max(...levels, 1e-6);

  return Array.from({ length: PEAK_BARS }, (_, bar) => {
    const level = levels[Math.min(levels.length - 1, Math.floor((bar * levels.length) / PEAK_BARS))] ?? 0;

    return String(Math.min(9, Math.round((level / top) * 9)));
  }).join("");
}

/** The loudness of an audio file at `url`, decoded on this device; null when it can't be read. */
async function decodePeaks(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);

    if (!response.ok) return null;
    const context = new AudioContext();

    try {
      const audio = await context.decodeAudioData(await response.arrayBuffer());

      return peaksFrom(audio.getChannelData(0));
    } finally {
      void context.close();
    }
  } catch {
    return null;
  }
}

/**
 * A voice note: play, its waveform filling as it plays, its time, and save, which keeps the file on the device to
 * play with no connection. A tap on the waveform seeks. What the device heard shows under it, in the message's
 * own words, for the user to check.
 */
export function VoiceNote({
  src,
  seconds,
  peaks,
  transcript = "",
  mine = false,
  label = "Voice note",
  name = label
}: {
  src: string;
  seconds: number | null;
  peaks: string | null;
  transcript?: string;
  mine?: boolean;
  label?: string;
  /** The file name a save gives it. */
  name?: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(seconds ?? 0);
  const [decoded, setDecoded] = useState<string | null>(null);
  const bars = barsOf(peaks ?? decoded);

  // A clip with no peaks of its own, such as one ky shows from a link, gets them from its sound when it can.
  useEffect(() => {
    if (peaks !== null) return;
    let live = true;
    void decodePeaks(src).then((found) => live && setDecoded(found));

    return () => {
      live = false;
    };
  }, [src, peaks]);

  const toggle = () => {
    const element = audio.current;

    if (element === null) return;

    if (element.paused) void element.play().catch(() => setPlaying(false));
    else element.pause();
  };

  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const element = audio.current;

    if (element === null || !Number.isFinite(element.duration)) return;
    const box = event.currentTarget.getBoundingClientRect();
    element.currentTime = ((event.clientX - box.left) / box.width) * element.duration;
  };

  const played = length > 0 ? at / length : 0;

  return (
    <figure className="voice-note" data-mine={mine || undefined}>
      <div className="voice-note-row">
        <button type="button" className="voice-note-play pressable" aria-label={playing ? `Pause ${label}` : `Play ${label}`} onClick={toggle}>
          <Icon name={playing ? "pause" : "play"} size={14} />
        </button>
        <div className="voice-note-wave" role="presentation" onPointerDown={seek}>
          {bars.map((level, index) => (
            <span key={index} style={{ height: `${Math.max(12, level * 100)}%` }} data-played={(index + 0.5) / bars.length <= played || undefined} />
          ))}
        </div>
        <span className="voice-note-time">{clock(playing || at > 0 ? at : length)}</span>
        <a className="voice-note-save pressable" href={src} download={name} aria-label={`Save ${label}`} title="Save to play offline">
          <Icon name="download" size={14} />
        </a>
      </div>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
        onTimeUpdate={(event) => setAt(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const { duration } = event.currentTarget;

          if (Number.isFinite(duration) && duration > 0) setLength(duration);
        }}
      />
      {transcript ? <figcaption className="voice-note-said">{transcript}</figcaption> : null}
    </figure>
  );
}

/**
 * A video, played where it is. A file named a video that has no picture, such as sound a download saved as .webm
 * or .mp4, plays as a voice note instead of a grey box.
 */
export function VideoClip({ src, label, caption, name }: { src: string; label: string; caption?: string | undefined; name?: string }) {
  const [sound, setSound] = useState(false);

  if (sound) return <VoiceNote src={src} seconds={null} peaks={null} transcript={caption} label={label} name={name} />;

  return (
    <figure className="video-clip">
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label={label}
        onLoadedMetadata={(event) => event.currentTarget.videoWidth === 0 && setSound(true)}
      />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

/** A clip the user sent, under their message. */
export function SentClip({ clip }: { clip: MediaClip }) {
  const src = `/files/${clip.file}`;

  return clip.kind === "audio" ? (
    <VoiceNote src={src} seconds={clip.seconds} peaks={clip.peaks} transcript={clip.transcript} mine label={clip.name} />
  ) : (
    <VideoClip src={src} label={clip.name} />
  );
}
