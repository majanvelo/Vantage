/**
 * music.ts — 100% SYNTHESIZED, original background music for solo renders.
 *
 * Why this file exists: the first cut of the generated bed stacked a few `sine`
 * sources into ONE held chord with a tremolo — it read as a monotone drone. The
 * owner's hard rule is that NO style may sound like a drone. So the bed is now a
 * real (small) composition, written sample-by-sample in TypeScript:
 *
 *   - a four-chord PROGRESSION that changes over time (vi–IV–I–V),
 *   - a MELODY/ARPEGGIO layer whose notes have per-note attack AND decay
 *     (notes start and stop — no infinite sustain),
 *   - a RHYTHM layer (kick / snare / hats / shaker or a soft pulse), so there is
 *     a beat rather than a wall of tone,
 *   - a bass line, a delay + early-reflection space, and a peak-normalized mix.
 *
 * Everything is pure math over sine/noise partials: no samples, no library, no
 * licensing, no copyright risk.
 *
 * The synth renders a SEAMLESS LOOP (exactly 4 chords long) rather than the full
 * film length. Note tails that run past the loop end wrap around and sum into the
 * start, so looping the buffer is click-free even for hour-long films. The render
 * pass loops this file with ffmpeg and applies the start/end fades at the film's
 * true length (see render.ts → finalizeSoloVideo).
 *
 * Three styles, deliberately distinct:
 *   calm   – slow (72 BPM), warm pad + gentle rising arpeggio, soft rim/shimmer
 *   upbeat – driving (118 BPM), bright plucks, kick+snare+hats, bass on every beat
 *   dreamy – spacious (60 BPM), evolving detuned pad, bell melody, no drums,
 *            noise swells + long delay
 */

export const MUSIC_STYLES = ["calm", "upbeat", "dreamy"] as const;
export type MusicStyle = (typeof MUSIC_STYLES)[number];
export const DEFAULT_MUSIC_STYLE: MusicStyle = "calm";

export function isMusicStyle(v: unknown): v is MusicStyle {
  return typeof v === "string" && (MUSIC_STYLES as readonly string[]).includes(v);
}

/**
 * Resolve a stored `prefs.music_style` value.
 *   - a valid style  → that style
 *   - "off"/"none"/"no"/"false" → null  (music disabled)
 *   - anything else  → `fallback` (default: calm), so we never silently lose music
 */
export function normalizeMusicStyle(
  v: unknown,
  fallback: MusicStyle | null = DEFAULT_MUSIC_STYLE
): MusicStyle | null {
  if (isMusicStyle(v)) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "" || s === "off" || s === "none" || s === "no" || s === "false") return null;
  }
  if (v === false || v === null) return null;
  return fallback;
}

/**
 * Pick a style deterministically when the user let the system decide
 * ("let the system do everything") and never touched the picker.
 */
export function autoMusicStyle(seed: string | null | undefined): MusicStyle {
  if (!seed) return DEFAULT_MUSIC_STYLE;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Bias toward the two mellow beds; upbeat for roughly a third of themes.
  const r = h % 3;
  return r === 0 ? "upbeat" : r === 1 ? "calm" : "dreamy";
}

// ---------------------------------------------------------------------------
// Tiny synth engine
// ---------------------------------------------------------------------------

const SR = 44100;
const TWO_PI = Math.PI * 2;

const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Deterministic noise so every render of a style sounds identical. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Stereo = { L: Float32Array; R: Float32Array; n: number };

/** A timbre = additive partials. `decay` is 1/seconds (0 = sustained). */
type Partial = { mult: number; amp: number; decay: number };
type Timbre = { partials: Partial[] };

const TIMBRES = {
  /** Warm sustained pad — mostly fundamental, a little 2nd/3rd harmonic. */
  pad: {
    partials: [
      { mult: 1, amp: 1, decay: 0 },
      { mult: 2, amp: 0.24, decay: 0 },
      { mult: 3, amp: 0.09, decay: 0 },
      { mult: 4, amp: 0.04, decay: 0 },
    ],
  },
  /** Brighter pad for upbeat. */
  padBright: {
    partials: [
      { mult: 1, amp: 1, decay: 0 },
      { mult: 2, amp: 0.42, decay: 0 },
      { mult: 3, amp: 0.2, decay: 0 },
      { mult: 4, amp: 0.12, decay: 0 },
      { mult: 5, amp: 0.05, decay: 0 },
    ],
  },
  /** Plucked string-ish: fast attack, harmonics die quickly. */
  pluck: {
    partials: [
      { mult: 1, amp: 1, decay: 2.1 },
      { mult: 2, amp: 0.45, decay: 3.4 },
      { mult: 3, amp: 0.22, decay: 5.0 },
      { mult: 5, amp: 0.09, decay: 7.5 },
    ],
  },
  /** FM-ish bell: inharmonic partials with long decays (dreamy melody). */
  bell: {
    partials: [
      { mult: 1, amp: 1, decay: 0.85 },
      { mult: 2.76, amp: 0.38, decay: 1.5 },
      { mult: 5.4, amp: 0.16, decay: 2.4 },
      { mult: 8.93, amp: 0.06, decay: 3.6 },
    ],
  },
  /** Round bass. */
  bass: {
    partials: [
      { mult: 0.5, amp: 0.55, decay: 0.9 },
      { mult: 1, amp: 1, decay: 0.7 },
      { mult: 2, amp: 0.26, decay: 1.6 },
    ],
  },
} satisfies Record<string, Timbre>;

type ToneOpts = {
  startFrames: number; // absolute frame index (wraps)
  freq: number;
  frames: number; // held length before release
  amp: number;
  timbre: Timbre;
  attack: number; // seconds
  release: number; // seconds
  decayFactor?: number; // multiplies per-partial decay
  pan?: number; // -1 left … 1 right
  detunes?: number[]; // cents per voice (defaults to [0])
  vibratoHz?: number;
  vibratoCents?: number;
};

/**
 * Add one note/tone into the buffer. The envelope is attack → hold → release,
 * and every partial additionally decays (except pad partials, decay 0), so notes
 * audibly START and STOP instead of sustaining forever.
 */
function addTone(buf: Stereo, o: ToneOpts) {
  const attackN = Math.max(1, Math.round(o.attack * SR));
  const releaseN = Math.max(1, Math.round(o.release * SR));
  const holdN = Math.max(1, Math.round(o.frames));
  const total = holdN + releaseN;
  const detunes = o.detunes ?? [0];
  const pan = o.pan ?? 0;
  const lg = Math.cos(((pan + 1) * Math.PI) / 4);
  const rg = Math.sin(((pan + 1) * Math.PI) / 4);
  const voices = detunes.length;
  const perVoice = o.amp / Math.sqrt(voices);
  const partials = o.timbre.partials;

  for (const cents of detunes) {
    const baseFreq = o.freq * Math.pow(2, cents / 1200);
    for (const p of partials) {
      const f = baseFreq * p.mult;
      if (f > SR / 2.05) continue; // skip aliasing partials
      const w = (TWO_PI * f) / SR;
      const pd = (p.decay || 0) * (o.decayFactor ?? 1);
      const pa = p.amp * perVoice;
      const vibW = o.vibratoHz ? (TWO_PI * o.vibratoHz) / SR : 0;
      const vibDepth = o.vibratoCents ? o.vibratoCents / 1200 : 0;
      for (let i = 0; i < total; i++) {
        // envelope
        let env: number;
        if (i < attackN) env = i / attackN;
        else if (i < holdN) env = 1;
        else {
          const t = (i - holdN) / releaseN;
          env = 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, t)); // cosine release
        }
        if (pd > 0) env *= Math.exp((-pd * i) / SR);
        if (env < 1e-4) continue;
        let phase = w * i;
        if (vibW) phase += vibDepth * Math.sin(vibW * i) * TWO_PI;
        const s = Math.sin(phase) * pa * env;
        const idx = (o.startFrames + i) % buf.n;
        buf.L[idx] += s * lg;
        buf.R[idx] += s * rg;
      }
    }
  }
}

/** Percussion voices (all synthesized: swept sine + shaped noise). */
function addKick(buf: Stereo, at: number, amp: number, startFreq = 150, endFreq = 46) {
  const len = Math.round(0.32 * SR);
  const decay = 11;
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = endFreq + (startFreq - endFreq) * Math.exp(-t * 34);
    phase += (TWO_PI * f) / SR;
    const env = Math.exp(-decay * t) * (1 - Math.exp(-t * 900));
    // soft saturation for body
    const s = Math.tanh(Math.sin(phase) * 1.5) * 0.75 * amp * env;
    const idx = (at + i) % buf.n;
    buf.L[idx] += s;
    buf.R[idx] += s;
  }
}

function addNoiseHit(
  buf: Stereo,
  at: number,
  amp: number,
  decay: number,
  opts: { tone?: number; toneAmp?: number; highpass?: number; pan?: number; attack?: number; len?: number; rng: () => number }
) {
  const len = Math.round((opts.len ?? 0.25) * SR);
  const hp = opts.highpass ?? 0;
  const pan = opts.pan ?? 0;
  const lg = Math.cos(((pan + 1) * Math.PI) / 4);
  const rg = Math.sin(((pan + 1) * Math.PI) / 4);
  const att = opts.attack ?? 0;
  let prev = 0;
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let env = Math.exp((-decay * i) / SR);
    if (att > 0) env *= Math.min(1, t / att);
    let s = 0;
    if (opts.tone) {
      phase += (TWO_PI * opts.tone) / SR;
      s += Math.sin(phase) * (opts.toneAmp ?? 0.5);
    }
    let n = opts.rng() * 2 - 1;
    if (hp > 0) {
      // first-difference high-pass (bright hats)
      const d = n - prev;
      prev = n;
      n = d * hp;
    }
    s = (s + n) * amp * env;
    const idx = (at + i) % buf.n;
    buf.L[idx] += s * lg;
    buf.R[idx] += s * rg;
  }
}

/** Ping-pong delay + early reflections, wrapped so the loop stays seamless. */
function addSpace(buf: Stereo, delayFrames: number, feedback: number, wet: number) {
  const n = buf.n;
  const taps: [number, number, number][] = [
    // [offset frames, gain, pan]
    [Math.round(0.023 * SR), 0.2, -0.7],
    [Math.round(0.041 * SR), 0.14, 0.7],
    [Math.round(0.067 * SR), 0.1, -0.3],
  ];
  const srcL = Float32Array.from(buf.L);
  const srcR = Float32Array.from(buf.R);
  for (const [off, g, pan] of taps) {
    const lg = Math.cos(((pan + 1) * Math.PI) / 4) * g;
    const rg = Math.sin(((pan + 1) * Math.PI) / 4) * g;
    for (let i = 0; i < n; i++) {
      const idx = (i + off) % n;
      buf.L[idx] += srcL[i] * lg;
      buf.R[idx] += srcR[i] * rg;
    }
  }
  // ping-pong delay
  let fbL = 0;
  let fbR = 0;
  for (let i = 0; i < n; i++) {
    const idx = (i + delayFrames) % n;
    const outL = fbR * wet;
    const outR = fbL * wet;
    buf.L[idx] += outL;
    buf.R[idx] += outR;
    fbL = srcL[i] + fbR * feedback;
    fbR = srcR[i] + fbL * feedback;
  }
}

/** Peak-normalize to `peak` (soft-limit anything above it). */
function normalize(buf: Stereo, peak: number) {
  let max = 0;
  for (let i = 0; i < buf.n; i++) {
    const a = Math.abs(buf.L[i]);
    const b = Math.abs(buf.R[i]);
    if (a > max) max = a;
    if (b > max) max = b;
  }
  if (max <= 0) return;
  const g = peak / max;
  for (let i = 0; i < buf.n; i++) {
    buf.L[i] = Math.tanh(buf.L[i] * g * 1.02) * 0.98;
    buf.R[i] = Math.tanh(buf.R[i] * g * 1.02) * 0.98;
  }
}

// ---------------------------------------------------------------------------
// The three compositions
// ---------------------------------------------------------------------------

/** vi – IV – I – V in A minor: Am7, Fmaj7, Cmaj7, G7 (pads + melody use these). */
const CHORDS: number[][] = [
  [57, 60, 64, 67], // Am7
  [53, 57, 60, 64], // Fmaj7
  [60, 64, 67, 71], // Cmaj7
  [55, 59, 62, 65], // G7
];
const BASS_ROOTS = [45, 41, 48, 43]; // A2, F2, C3, G2
const CHORD_BEATS = 4;

type StylePlan = {
  bpm: number;
  /** Pad: one long tone per chord (envelope overlaps into the next chord). */
  pad: { amp: number; attack: number; release: number; detunes: number[]; vibratoHz: number; vibratoCents: number; timbre: Timbre; octaveUp: boolean };
  /** Arpeggio/melody: `steps` subdivision of the beat, pattern = chord-degree indices. */
  arp: { perBeat: number; pattern: number[]; amp: number; attack: number; release: number; timbre: Timbre; octave: number[]; gate: number };
  /** Bass line, in beats within a chord. */
  bass: { beats: number[]; amp: number; attack: number; release: number; gate: number };
  /** Percussion patterns, in 16th-note steps within a chord (16 steps = 4 beats). */
  perc: { kick: number[]; snare: number[]; hat: number[]; shaker: number[] };
  /** Delay time in beats (0 disables the delay). */
  delayBeats: number;
  /** Slow noise swell into each chord (dreamy). */
  swell: number;
};

const PLANS: Record<MusicStyle, StylePlan> = {
  calm: {
    bpm: 72,
    pad: {
      amp: 0.3, attack: 1.1, release: 1.6,
      detunes: [-7, 0, 7], vibratoHz: 0.22, vibratoCents: 6,
      timbre: TIMBRES.pad, octaveUp: true,
    },
    arp: {
      perBeat: 2, pattern: [0, 1, 2, 3, 2, 1, 3, 2], amp: 0.19,
      attack: 0.006, release: 0.5, timbre: TIMBRES.pluck, octave: [12, 12, 24], gate: 0.9,
    },
    bass: { beats: [0, 2], amp: 0.26, attack: 0.02, release: 0.8, gate: 1.6 },
    perc: {
      kick: [0],
      snare: [],
      hat: [4, 12],
      shaker: [2, 6, 10, 14],
    },
    delayBeats: 0.75,
    swell: 0,
  },
  upbeat: {
    bpm: 118,
    pad: {
      amp: 0.22, attack: 0.22, release: 0.45,
      detunes: [-5, 0, 5], vibratoHz: 4.5, vibratoCents: 3,
      timbre: TIMBRES.padBright, octaveUp: false,
    },
    arp: {
      perBeat: 4, pattern: [0, 2, 1, 3, 2, 3, 1, 2], amp: 0.16,
      attack: 0.004, release: 0.22, timbre: TIMBRES.pluck, octave: [12, 24, 12, 24], gate: 0.55,
    },
    bass: { beats: [0, 1, 2, 3], amp: 0.3, attack: 0.008, release: 0.3, gate: 0.6 },
    perc: {
      kick: [0, 6, 8, 14],
      snare: [4, 12],
      hat: [0, 2, 4, 6, 8, 10, 12, 14],
      shaker: [1, 3, 5, 7, 9, 11, 13, 15],
    },
    delayBeats: 0.375,
    swell: 0,
  },
  dreamy: {
    bpm: 60,
    pad: {
      amp: 0.34, attack: 2.1, release: 2.6,
      detunes: [-11, -4, 4, 11], vibratoHz: 0.13, vibratoCents: 9,
      timbre: TIMBRES.pad, octaveUp: true,
    },
    arp: {
      perBeat: 1, pattern: [3, 1, 2, 0], amp: 0.2,
      attack: 0.008, release: 1.5, timbre: TIMBRES.bell, octave: [24, 12, 24, 12], gate: 1.0,
    },
    bass: { beats: [0], amp: 0.2, attack: 0.6, release: 1.4, gate: 3.0 },
    perc: { kick: [], snare: [], hat: [], shaker: [] },
    delayBeats: 1.0,
    swell: 0.05,
  },
};

export function loopSecondsFor(style: MusicStyle): number {
  const plan = PLANS[style];
  return (CHORD_BEATS * 60 * 4) / plan.bpm;
}

/**
 * Seconds per beat for a style (60 / BPM). The renderer uses this to cut
 * photo shots on the music's beat grid, so a slow bed gets longer shots and an
 * upbeat bed gets snappier ones — the cuts read as musical rather than arbitrary.
 */
export function secondsPerBeat(style: MusicStyle): number {
  return 60 / PLANS[style].bpm;
}

/**
 * Synthesize the style's seamless 4-chord loop as interleaved-free stereo PCM.
 */
function synthesize(style: MusicStyle): Stereo {
  const plan = PLANS[style];
  const samplesPerBeat = Math.round((60 / plan.bpm) * SR);
  const samplesPerChord = samplesPerBeat * CHORD_BEATS;
  const n = samplesPerChord * CHORDS.length;
  const buf: Stereo = { L: new Float32Array(n), R: new Float32Array(n), n };
  const rng = makeRng(style === "calm" ? 1337 : style === "upbeat" ? 90210 : 4242);
  const step16 = samplesPerBeat / 4;

  for (let c = 0; c < CHORDS.length; c++) {
    const chord = CHORDS[c];
    const at = c * samplesPerChord;

    // --- PAD: one long tone per chord, release bleeding into the next chord ---
    // The release wraps around the loop end back to the start, so the pad is
    // continuous across the loop seam.
    for (let v = 0; v < chord.length; v++) {
      addTone(buf, {
        startFrames: at,
        freq: midiToFreq(chord[v]),
        frames: samplesPerChord,
        amp: (plan.pad.amp / chord.length) * (v === 0 ? 1.15 : 1),
        timbre: plan.pad.timbre,
        attack: plan.pad.attack,
        release: plan.pad.release,
        detunes: plan.pad.detunes,
        vibratoHz: plan.pad.vibratoHz,
        vibratoCents: plan.pad.vibratoCents,
        pan: v % 2 === 0 ? -0.35 : 0.35,
      });
    }
    // sparkle an octave above the pad for airiness (calm/dreamy)
    if (plan.pad.octaveUp) {
      addTone(buf, {
        startFrames: at,
        freq: midiToFreq(chord[2] + 12),
        frames: samplesPerChord,
        amp: plan.pad.amp * 0.28,
        timbre: plan.pad.timbre,
        attack: plan.pad.attack * 1.3,
        release: plan.pad.release,
        detunes: [-4, 4],
        vibratoHz: plan.pad.vibratoHz,
        vibratoCents: plan.pad.vibratoCents,
      });
    }

    // --- BASS ---
    for (const b of plan.bass.beats) {
      addTone(buf, {
        startFrames: at + Math.round(b * samplesPerBeat),
        freq: midiToFreq(BASS_ROOTS[c]),
        frames: Math.round(plan.bass.gate * samplesPerBeat),
        amp: plan.bass.amp,
        timbre: TIMBRES.bass,
        attack: plan.bass.attack,
        release: plan.bass.release,
      });
    }

    // --- ARPEGGIO / MELODY: every note has its own attack + decay ---
    const steps = Math.round(CHORD_BEATS * plan.arp.perBeat);
    for (let s = 0; s < steps; s++) {
      const deg = plan.arp.pattern[s % plan.arp.pattern.length];
      const chordTone = chord[((deg % chord.length) + chord.length) % chord.length];
      const oct = plan.arp.octave[s % plan.arp.octave.length];
      addTone(buf, {
        startFrames: at + Math.round(s * (samplesPerChord / steps)),
        freq: midiToFreq(chordTone + oct),
        frames: Math.round(((samplesPerChord / steps) * plan.arp.gate)),
        amp: plan.arp.amp * (s % 4 === 0 ? 1.15 : 0.9),
        timbre: plan.arp.timbre,
        attack: plan.arp.attack,
        release: plan.arp.release,
        pan: s % 2 === 0 ? 0.25 : -0.25,
      });
    }

    // --- PERCUSSION (16th grid) — a real beat, not a wall of tone ---
    for (const s of plan.perc.kick) addKick(buf, at + Math.round(s * step16), 0.5);
    for (const s of plan.perc.snare) {
      addNoiseHit(buf, at + Math.round(s * step16), 0.28, 24, {
        tone: 190, toneAmp: 0.35, highpass: 1.4, len: 0.25, rng,
      });
    }
    for (const s of plan.perc.hat) {
      addNoiseHit(buf, at + Math.round(s * step16), s % 4 === 0 ? 0.055 : 0.032, 60, {
        highpass: 2.6, len: 0.09, pan: 0.22, rng,
      });
    }
    for (const s of plan.perc.shaker) {
      addNoiseHit(buf, at + Math.round(s * step16), 0.022, 45, {
        highpass: 3.2, len: 0.07, pan: -0.28, rng,
      });
    }
    // soft rim tick on the off-beats — the "movement" pulse for calm
    if (plan.perc.kick.length === 0 && plan.perc.hat.length > 0) {
      for (const s of plan.perc.hat) {
        addNoiseHit(buf, at + Math.round(s * step16), 0.05, 26, {
          tone: 900, toneAmp: 0.5, highpass: 1.0, len: 0.14, rng,
        });
      }
    }
    // airy swell rising into each chord (dreamy space)
    if (plan.swell > 0) {
      addNoiseHit(buf, at + samplesPerChord - Math.round(samplesPerBeat * 2), plan.swell, 0.6, {
        highpass: 2.2, len: (samplesPerBeat * 2) / SR, attack: (samplesPerBeat * 1.6) / SR, pan: 0.4, rng,
      });
    }
  }

  addSpace(buf, Math.max(1, Math.round(plan.delayBeats * samplesPerBeat)), 0.34, 0.3);
  normalize(buf, 0.72);
  return buf;
}

/** Encode interleaved 16-bit PCM WAV bytes for a style's seamless loop. */
export function synthesizeMusicWav(style: MusicStyle, sampleRate = SR): Uint8Array {
  const buf = synthesize(style);
  const n = buf.n;
  const bytes = new Uint8Array(44 + n * 4);
  const view = new DataView(bytes.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 4, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true); // bits
  ascii(36, "data");
  view.setUint32(40, n * 4, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, buf.L[i]));
    const r = Math.max(-1, Math.min(1, buf.R[i]));
    view.setInt16(off, Math.round(l * 32767), true);
    view.setInt16(off + 2, Math.round(r * 32767), true);
    off += 4;
  }
  return bytes;
}
