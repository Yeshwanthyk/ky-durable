import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
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

/** The speeds a voice note steps through, and where the user's choice is kept for every note. */
const SPEEDS: readonly number[] = [1, 1.5, 2];

const SPEED_KEY = "ky.voice-note-speed";

function savedSpeed(): number {
  try {
    const saved = Number(localStorage.getItem(SPEED_KEY));

    return SPEEDS.includes(saved) ? saved : 1;
  } catch {
    return 1;
  }
}

/** The note playing now; another that starts pauses it, so two never talk over each other. */
let speaking: HTMLAudioElement | null = null;

/**
 * A voice note: play, its waveform filling as it plays, its time, its speed, and save, which keeps the file on the
 * device to play with no connection. A tap or drag on the waveform seeks, and the arrow keys step it. What the
 * device heard shows under it, in the message's own words, for the user to check.
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
  const [speed, setSpeed] = useState(savedSpeed);
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

  useEffect(() => {
    if (audio.current !== null) audio.current.playbackRate = speed;
  }, [speed]);

  // The waveform fills every frame while it plays, not in the jumps timeupdate makes.
  useEffect(() => {
    if (!playing) return;

    let frame = requestAnimationFrame(function tick() {
      if (audio.current !== null) setAt(audio.current.currentTime);
      frame = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const toggle = () => {
    const element = audio.current;

    if (element === null) return;

    if (element.paused) void element.play().catch(() => setPlaying(false));
    else element.pause();
  };

  const nextSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;

    setSpeed(next);

    try {
      localStorage.setItem(SPEED_KEY, String(next));
    } catch {
      // A browser that keeps nothing plays at this speed until the page closes.
    }
  };

  const jump = (to: number) => {
    const element = audio.current;

    if (element === null || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.min(element.duration, Math.max(0, to));
    setAt(element.currentTime);
  };

  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();

    jump(((event.clientX - box.left) / box.width) * (audio.current?.duration ?? 0));
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -Infinity, End: Infinity }[event.key];

    if (event.key === " " || event.key === "Enter") toggle();
    else if (step === undefined) return;
    else jump(Number.isFinite(step) ? at + step : step < 0 ? 0 : length);
    event.preventDefault();
  };

  const played = length > 0 ? at / length : 0;

  return (
    <figure className="voice-note" data-mine={mine || undefined}>
      <div className="voice-note-row">
        <button type="button" className="voice-note-play pressable" aria-label={playing ? `Pause ${label}` : `Play ${label}`} onClick={toggle}>
          <Icon name={playing ? "pause" : "play"} size={14} />
        </button>
        <div
          className="voice-note-wave"
          role="slider"
          tabIndex={0}
          aria-label={`Seek ${label}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(at)}
          aria-valuetext={`${clock(at)} of ${clock(length)}`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            seek(event);
          }}
          onPointerMove={(event) => event.currentTarget.hasPointerCapture(event.pointerId) && seek(event)}
          onKeyDown={keys}
        >
          {bars.map((level, index) => (
            <span key={index} style={{ height: `${Math.max(12, level * 100)}%` }} data-played={(index + 0.5) / bars.length <= played || undefined} />
          ))}
        </div>
        <span className="voice-note-time">{clock(playing || at > 0 ? at : length)}</span>
        <button type="button" className="voice-note-speed pressable" aria-label={`Speed ${speed}×, change`} title="Playback speed" onClick={nextSpeed}>
          {speed}×
        </button>
        <a className="voice-note-save pressable" href={src} download={name} aria-label={`Save ${label}`} title="Save to play offline">
          <Icon name="download" size={14} />
        </a>
      </div>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={(event) => {
          if (speaking !== null && speaking !== event.currentTarget) speaking.pause();
          speaking = event.currentTarget;
          setPlaying(true);
        }}
        onPause={(event) => {
          if (speaking === event.currentTarget) speaking = null;
          setPlaying(false);
        }}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
        onTimeUpdate={(event) => setAt(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const { duration } = event.currentTarget;

          event.currentTarget.playbackRate = speed;

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
