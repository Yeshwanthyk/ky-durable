import { useEffect, useRef, useState } from "react";
import { digits } from "./Media";

/**
 * A voice note, recorded in the browser. MediaRecorder keeps the sound; the device's own speech
 * recognizer (the Web Speech API: Apple's dictation in Safari, the system's in Chrome) writes down
 * what was said as it is said, so the words come from the phone, not from a server ky calls. A
 * browser without a recognizer still records: the note goes without words, and the model is told so.
 */

/** As t3code caps dictation: a note longer than this stops by itself. */
const MAX_RECORDING_SECONDS = 5 * 60;

/** Bars the live waveform shows while recording. */
const LIVE_BARS = 28;

const LEVEL_EVERY_MS = 80;

export type Recording = {
  readonly blob: Blob;
  readonly type: string;
  readonly seconds: number;
  readonly peaks: string;
  readonly transcript: string;
};

export type Recorder =
  | { readonly state: "idle" }
  | { readonly state: "starting" }
  | {
      readonly state: "recording";
      readonly seconds: number;
      /** The last LIVE_BARS levels, 0–1, newest last. */
      readonly levels: readonly number[];
      /** What the recognizer has heard so far, the words it is still unsure of last. */
      readonly heard: string;
    };

/** The Web Speech API's recognizer, under either of its names; null where the browser has none. */
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

// TypeScript's DOM types have the recognizer's events but not the recognizer: Chrome names it with a prefix, Safari both ways, Firefox not at all.
declare global {
  interface Window {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  }
}

function newRecognition(): Recognition | null {
  const Speech = window.SpeechRecognition ?? window.webkitSpeechRecognition;

  return Speech ? new Speech() : null;
}

/** A type this browser records sound in: Safari only records mp4, Chrome and Firefox webm. */
function recordingType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }

  return "";
}

type Session = {
  readonly stream: MediaStream;
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly context: AudioContext;
  readonly recognition: Recognition | null;
  /** Each recognized phrase, final ones kept, by its index in the recognizer's results. */
  readonly phrases: string[];
  readonly levels: number[];
  readonly startedAt: number;
  timer: number;
  /** Stopping: the recognizer is not restarted when it ends. */
  done: boolean;
};

const said = (phrases: readonly string[]) => phrases.join(" ").replace(/\s+/g, " ").trim();

export function useRecorder({ onError }: { onError: (message: string) => void }) {
  const [recorder, setRecorder] = useState<Recorder>({ state: "idle" });
  const session = useRef<Session | null>(null);
  const finish = useRef<((recording: Recording | null) => void) | null>(null);

  const release = (current: Session) => {
    current.done = true;
    clearInterval(current.timer);
    current.recognition?.abort();

    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close();
    session.current = null;
    setRecorder({ state: "idle" });
  };

  // A note still recording when the composer goes away is thrown away, and the microphone let go.
  useEffect(() => () => {
    if (session.current) release(session.current);
  }, []);

  const start = async () => {
    if (session.current !== null || typeof MediaRecorder === "undefined" || !navigator.mediaDevices) {
      if (session.current === null) onError("This browser can't record sound.");

      return;
    }

    setRecorder({ state: "starting" });
    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      setRecorder({ state: "idle" });
      onError(error instanceof DOMException && error.name === "NotAllowedError" ? "ky may not use the microphone: allow it in the browser's settings." : "No microphone to record with.");

      return;
    }

    const type = recordingType();
    const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const recognition = newRecognition();

    const current: Session = {
      stream,
      recorder: media,
      chunks: [],
      context,
      recognition,
      phrases: [],
      levels: [],
      startedAt: Date.now(),
      timer: 0,
      done: false
    };

    session.current = current;
    media.ondataavailable = (event) => {
      if (event.data.size > 0) current.chunks.push(event.data);
    };

    media.onstop = () => {
      const blob = new Blob(current.chunks, { type: media.mimeType || type || "audio/webm" });
      const seconds = Math.max(1, Math.round((Date.now() - current.startedAt) / 1000));
      const recording = { blob, type: blob.type, seconds, peaks: digits(current.levels), transcript: said(current.phrases) };
      const then = finish.current;
      finish.current = null;
      release(current);
      then?.(recording.blob.size > 0 ? recording : null);
    };

    if (recognition) {
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      // A phrase's index is where the recognizer keeps it in this run's results; a restart begins a new run after them.
      let base = 0;
      recognition.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index++) {
          current.phrases[base + index] = event.results[index]?.[0]?.transcript ?? "";
        }
      };

      // Safari's recognizer stops after a pause; while the note records, it listens again.
      recognition.onend = () => {
        if (current.done) return;
        base = current.phrases.length;

        try {
          recognition.start();
        } catch {
          // Started already, or the page lost the microphone: the note still records.
        }
      };

      recognition.onerror = () => {};

      try {
        recognition.start();
      } catch {
        // The note records without words.
      }
    }

    media.start(1000);

    current.timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;

      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      current.levels.push(peak);
      const seconds = (Date.now() - current.startedAt) / 1000;

      if (seconds >= MAX_RECORDING_SECONDS) {
        void stop();

        return;
      }

      setRecorder({
        state: "recording",
        seconds,
        levels: current.levels.slice(-LIVE_BARS).map((level) => Math.min(1, level * 2.5)),
        heard: said(current.phrases)
      });
    }, LEVEL_EVERY_MS);
  };

  /** Stop recording; the note comes back once the recorder has written its last data, or null when it has none. */
  function stop(): Promise<Recording | null> {
    const current = session.current;

    if (current === null) return Promise.resolve(null);

    return new Promise((resolve) => {
      finish.current = resolve;
      current.done = true;
      // The recognizer gets a moment to give its last words before the recorder stops.
      current.recognition?.stop();
      window.setTimeout(() => {
        if (current.recorder.state !== "inactive") current.recorder.stop();
      }, current.recognition ? 400 : 0);
    });
  }

  const cancel = () => {
    const current = session.current;

    if (current === null) return;
    finish.current = null;
    current.recorder.onstop = null;

    if (current.recorder.state !== "inactive") current.recorder.stop();
    release(current);
  };

  return { recorder, start, stop, cancel };
}
