//! Bloubs: the small characters ky and its specialists wear, as the web draws them
//! (`src/ui/Bloub.tsx`, `src/ui/bloub-motion.ts`, `src/avatars/contract.ts`). A spec picks a
//! rounded body, one or two eyes, cheeks, feet and a part on top. It breathes and blinks at rest,
//! looks around, hops with happy eyes under the pointer, squishes and sends a heart when clicked,
//! gets dizzy when poked five times quickly, leans in with dots while it works, and droops with a
//! sweat drop when its last answer failed.
//!
//! The saved bloubs come in the server's `avatars` frame; a specialist without one gets one rolled
//! from its id, the same one the web rolls. ky without a saved bloub wears the catalog blob
//! (`crate::blob`).
//!
//! Drawn as a Rune `Shape` each frame. An animated bloub keeps its `Motion` in `Blobs`, which the
//! view stamps as it draws and `poll` steps; one not drawn by the latest view is dropped. A still
//! one draws its mood's pose and keeps nothing.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use rune::{Color, El, LineCap, Path, Shape, canvas};
use serde::Deserialize;

/// The owner key of ky's own avatar.
pub const KY: &str = "ky";

/// The fence an avatar tool's result wraps its previews in (`BLOUBS_FENCE`).
const FENCE: &str = "```bloubs\n";

// ---------------------------------------------------------------------------------------------
// The spec

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Spec {
    #[serde(default)]
    pub name: Option<String>,
    pub body: Body,
    pub eyes: Eyes,
    pub top: Top,
    pub cheeks: bool,
    pub feet: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Body {
    pub w: f32,
    pub h: f32,
    pub corner: f32,
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Eyes {
    pub count: u8,
    pub size: f32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Top {
    pub kind: TopKind,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TopKind {
    None,
    Antenna,
    Leaf,
    Ears,
    Sprout,
    Tuft,
}

const TOPS: [TopKind; 6] = [TopKind::None, TopKind::Antenna, TopKind::Leaf, TopKind::Ears, TopKind::Sprout, TopKind::Tuft];

impl Spec {
    /// A spec as the wire carries it, or `None` when it isn't one the web would draw.
    pub fn read(v: &serde_json::Value) -> Option<Spec> {
        let spec: Spec = serde_json::from_value(v.clone()).ok()?;
        let hex_ok = |h: &str| h.len() == 7 && h.starts_with('#') && h[1..].chars().all(|c| c.is_ascii_hexdigit());
        let finite = [spec.body.w, spec.body.h, spec.body.corner, spec.eyes.size].iter().all(|n| n.is_finite());
        (finite && matches!(spec.eyes.count, 1 | 2) && hex_ok(&spec.body.color) && spec.top.color.as_deref().is_none_or(hex_ok)).then_some(spec)
    }
}

/// The saved bloubs in an `avatars` frame, by "ky" or a specialist's id.
pub fn saved(avatars: &serde_json::Value) -> HashMap<String, Spec> {
    avatars.as_object().map(|all| all.iter().filter_map(|(owner, v)| Some((owner.clone(), Spec::read(v)?))).collect()).unwrap_or_default()
}

/// The bloubs an avatar tool's result shows, from its fenced block; none for any other output.
pub fn previews(output: &str) -> Vec<Spec> {
    let Some(start) = output.find(FENCE).map(|i| i + FENCE.len()) else { return Vec::new() };
    let Some(len) = output[start..].find("\n```") else { return Vec::new() };
    let Ok(serde_json::Value::Array(all)) = serde_json::from_str(&output[start..start + len]) else { return Vec::new() };
    let specs: Option<Vec<Spec>> = all.iter().map(Spec::read).collect();
    specs.unwrap_or_default()
}

/// JavaScript's `Math.round`, which the web's fit rounds with.
fn js_round(x: f32) -> f32 {
    (x + 0.5).floor()
}

fn clamp(value: f32, low: f32, high: f32) -> f32 {
    js_round(value.max(low).min(high))
}

fn max_eye(w: f32, count: u8) -> f32 {
    if count == 1 { (w / 2.0 - 14.0).min(32.0) } else { ((w / 2.0 - 8.0) / 2.55).min(18.0) }
}

/// The web's `fit`: sizes clamped to what draws well, colours lower-case.
fn fit(spec: Spec) -> Spec {
    let w = clamp(spec.body.w, 80.0, 124.0);
    let h = clamp(spec.body.h, 80.0, 124.0);
    let count = spec.eyes.count;
    let color = spec.body.color.to_lowercase();
    Spec {
        name: spec.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
        body: Body { w, h, corner: clamp(spec.body.corner, 0.0, w.min(h) / 2.0), color: color.clone() },
        eyes: Eyes { count, size: clamp(spec.eyes.size, 8.0, max_eye(w, count)) },
        top: if spec.top.kind == TopKind::None {
            Top { kind: TopKind::None, color: None }
        } else {
            Top { kind: spec.top.kind, color: Some(spec.top.color.unwrap_or(color).to_lowercase()) }
        },
        cheeks: spec.cheeks,
        feet: spec.feet,
    }
}

const BODIES: [&str; 12] = ["#f0393c", "#3d8bff", "#f4ece0", "#8a5cf6", "#22b8a6", "#ff9f1c", "#ff6fa8", "#7bd389", "#ffd23f", "#5ec8f2", "#b48cff", "#ff7a59"];
const ACCENTS: [&str; 7] = ["#ffc93c", "#3cc46a", "#ff7ab8", "#7cc4ff", "#ffffff", "#ff5d5d", "#a0e548"];

/// The web's seeded random (FNV over the seed's UTF-16 units, then mulberry32), bit for bit.
fn random(seed: &str) -> impl FnMut() -> f32 {
    let mut state: u32 = 2_166_136_261;
    for ch in seed.chars() {
        let mut units = [0u16; 2];
        state = (state ^ ch.encode_utf16(&mut units)[0] as u32).wrapping_mul(16_777_619);
    }
    move || {
        state = state.wrapping_add(0x6d2b_79f5);
        let mut t = (state ^ (state >> 15)).wrapping_mul(1 | state);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64 / 4_294_967_296.0) as f32
    }
}

/// The bloub the web rolls for a specialist that has none saved (`rollSpec`).
pub fn roll(seed: &str) -> Spec {
    let mut next = random(seed);
    let between = |next: &mut dyn FnMut() -> f32, low: f32, high: f32| low + next() * (high - low);
    let w = between(&mut next, 90.0, 120.0);
    let h = between(&mut next, 90.0, 118.0);
    let count = if next() < 0.35 { 1 } else { 2 };
    let color = BODIES[(next() * BODIES.len() as f32) as usize % BODIES.len()];
    let kind = TOPS[(next() * TOPS.len() as f32) as usize % TOPS.len()];
    let corner = between(&mut next, 0.25, 0.5) * w.min(h);
    let size = if count == 1 { between(&mut next, 22.0, 30.0) } else { between(&mut next, 11.0, 17.0) };
    let top = if kind == TopKind::Ears {
        Top { kind, color: Some(color.into()) }
    } else {
        let accents: Vec<&str> = ACCENTS.iter().copied().filter(|a| *a != color).collect();
        Top { kind, color: Some(accents[(next() * accents.len() as f32) as usize % accents.len()].into()) }
    };
    let cheeks = next() < 0.75;
    let feet = next() < 0.7;
    fit(Spec { name: None, body: Body { w, h, corner, color: color.into() }, eyes: Eyes { count, size }, top, cheeks, feet })
}

// ---------------------------------------------------------------------------------------------
// Motion (`bloub-motion.ts`)

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mood {
    Idle,
    Working,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pose {
    Idle,
    Hover,
    Working,
    Failed,
    Dizzy,
}

/// A pose's targets; the drawn values ease toward them. `rate` is how fast it breathes.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Params {
    hop: f32,
    bob: f32,
    rate: f32,
    tilt: f32,
    lid: f32,
    happy: f32,
    smile: f32,
    open: f32,
    dots: f32,
    drop: f32,
    sag: f32,
    blush: f32,
    dizzy: f32,
}

const fn params(v: [f32; 13]) -> Params {
    Params { hop: v[0], bob: v[1], rate: v[2], tilt: v[3], lid: v[4], happy: v[5], smile: v[6], open: v[7], dots: v[8], drop: v[9], sag: v[10], blush: v[11], dizzy: v[12] }
}

//                                 hop  bob  rate tilt lid  happy smile open dots drop sag blush dizzy
const IDLE: Params = params([0.0, 1.4, 2.2, 0.0, 0.0, 0.0, 0.7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
const HOVER: Params = params([1.0, 0.0, 2.2, 0.0, 0.0, 1.0, 1.0, 0.8, 0.0, 0.0, 0.0, 1.0, 0.0]);
const WORKING: Params = params([0.0, 1.0, 9.0, 3.0, 0.2, 0.0, 0.2, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0]);
const FAILED: Params = params([0.0, 0.5, 1.4, 4.0, 0.5, 0.0, -0.7, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0]);
const DIZZY: Params = params([0.0, 0.6, 3.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.3, 0.0, 1.0]);

impl Pose {
    fn params(self) -> Params {
        match self {
            Pose::Idle => IDLE,
            Pose::Hover => HOVER,
            Pose::Working => WORKING,
            Pose::Failed => FAILED,
            Pose::Dizzy => DIZZY,
        }
    }

    /// Where the pose looks; `None` follows where it's told, or wanders.
    fn gaze(self) -> Option<[f32; 2]> {
        match self {
            Pose::Hover | Pose::Dizzy => Some([0.0, 0.0]),
            Pose::Working => Some([0.5, 0.5]),
            Pose::Failed => Some([0.0, 0.55]),
            Pose::Idle => None,
        }
    }
}

impl Mood {
    fn pose(self) -> Pose {
        match self {
            Mood::Idle => Pose::Idle,
            Mood::Working => Pose::Working,
            Mood::Failed => Pose::Failed,
        }
    }
}

const POKES: usize = 5;
const POKE_WINDOW: f64 = 2.5;
const DIZZY_FOR: f64 = 2.2;
const HEART_LIFE: f64 = 1.1;

/// The drawn values: a pose's, plus where the eyes look and how squashed a click left it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Drawn {
    p: Params,
    gx: f32,
    gy: f32,
    squish: f32,
}

/// Everything that moves between frames.
#[derive(Clone, Debug)]
pub struct Motion {
    d: Drawn,
    t: f64,
    blink_at: f64,
    pokes: Vec<f64>,
    dizzy_until: f64,
    hearts: Vec<f64>,
    rng: u32,
}

fn ease(from: f32, to: f32, k: f32) -> f32 {
    from + (to - from) * k
}

/// A seed's start in the breathing cycle, so a row of bloubs doesn't breathe in step.
fn phase_of(seed: &str) -> f64 {
    (seed.encode_utf16().map(u32::from).sum::<u32>() % 9) as f64
}

fn settled(mood: Mood) -> Drawn {
    Drawn { p: mood.pose().params(), gx: 0.0, gy: 0.0, squish: 0.0 }
}

impl Motion {
    pub fn new(mood: Mood, seed: &str) -> Motion {
        let t = phase_of(seed);
        let mut m = Motion { d: settled(mood), t, blink_at: 0.0, pokes: Vec::new(), dizzy_until: 0.0, hearts: Vec::new(), rng: 0x9e37_79b9 ^ (t as u32 + 1) };
        m.blink_at = t + 1.0 + m.random() * 3.0;
        m
    }

    fn random(&mut self) -> f64 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        self.rng as f64 / 4_294_967_296.0
    }

    fn pose(&self, mood: Mood, hovered: bool) -> Pose {
        if self.t < self.dizzy_until {
            Pose::Dizzy
        } else if hovered && mood == Mood::Idle {
            Pose::Hover
        } else {
            mood.pose()
        }
    }

    /// One frame toward `pose`: ease, look, spring back from a click, let hearts fade, book the next blink.
    fn advance(&mut self, pose: Pose, seconds: f64) {
        let dt = seconds.clamp(0.0, 0.05);
        let k = 1.0 - (-dt * 10.0).exp() as f32;
        let target = pose.params();
        self.t += dt;
        let p = &mut self.d.p;
        for (from, to) in [
            (&mut p.hop, target.hop),
            (&mut p.bob, target.bob),
            (&mut p.tilt, target.tilt),
            (&mut p.lid, target.lid),
            (&mut p.happy, target.happy),
            (&mut p.smile, target.smile),
            (&mut p.open, target.open),
            (&mut p.dots, target.dots),
            (&mut p.drop, target.drop),
            (&mut p.sag, target.sag),
            (&mut p.blush, target.blush),
            (&mut p.dizzy, target.dizzy),
        ] {
            *from = ease(*from, to, k);
        }
        p.rate = target.rate;
        let t = self.t as f32;
        let gaze = pose.gaze().unwrap_or([(t * 0.7).sin() * 0.45, (t * 0.43 + 1.3).sin() * 0.3]);
        self.d.gx = ease(self.d.gx, gaze[0], k);
        self.d.gy = ease(self.d.gy, gaze[1], k);
        self.d.squish = ease(self.d.squish, 0.0, 1.0 - (-dt * 6.0).exp() as f32);
        let now = self.t;
        self.hearts.retain(|born| now - born < HEART_LIFE);
        if self.t > self.blink_at + 0.15 {
            self.blink_at = self.t + 2.4 + self.random() * 3.0;
        }
    }

    /// A click: it squishes and sends a heart; the fifth within a few seconds makes it dizzy.
    fn poke(&mut self) {
        self.d.squish = 1.0;
        self.hearts.push(self.t);
        let now = self.t;
        self.pokes.retain(|at| now - at < POKE_WINDOW);
        self.pokes.push(now);
        if self.pokes.len() >= POKES {
            self.dizzy_until = self.t + DIZZY_FOR;
            self.pokes.clear();
        }
    }

    /// How far through a blink it is, 0 open to 1 shut.
    fn blink(&self) -> f32 {
        let at = ((self.t - self.blink_at) / 0.15) as f32;
        if (0.0..=1.0).contains(&at) { (at * std::f32::consts::PI).sin() } else { 0.0 }
    }
}

// ---------------------------------------------------------------------------------------------
// The registry

/// The saved bloubs, and the motion of each animated avatar on screen.
#[derive(Default)]
pub struct Blobs {
    /// From the `avatars` frame, by "ky" or a specialist's id.
    pub saved: HashMap<String, Spec>,
    live: RefCell<HashMap<String, Live>>,
    rolled: RefCell<HashMap<String, Spec>>,
    /// Bumps with each view; an avatar drawn by it carries this stamp.
    view: Cell<u64>,
    reduced: Cell<bool>,
    /// The view drew an animated avatar `poll` isn't stepping yet.
    pub fresh: Cell<bool>,
    /// Bumps each stepped frame: a memo holding an animated avatar keys on it.
    pub frame: u64,
    last: Option<f64>,
    /// Wakes the window, so `poll` starts stepping an avatar the view just drew.
    pub wake: Option<rune::Waker>,
}

struct Live {
    motion: Motion,
    mood: Mood,
    hovered: bool,
    stamp: u64,
}

impl Blobs {
    pub fn new(wake: rune::Waker) -> Blobs {
        Blobs { wake: Some(wake), ..Default::default() }
    }

    /// The view starts drawing: avatars it draws are kept, others dropped at the next step.
    pub fn begin(&self, reduced_motion: bool) {
        self.view.set(self.view.get() + 1);
        self.reduced.set(reduced_motion);
    }

    /// One frame at `clock` seconds: step every animated avatar the last view drew. True while
    /// any is on screen, so the caller asks for the next frame and redraws.
    pub fn step(&mut self, clock: f64) -> bool {
        let dt = self.last.map_or(0.0, |last| clock - last);
        self.fresh.set(false);
        let view = self.view.get();
        let live = self.live.get_mut();
        live.retain(|_, l| l.stamp == view);
        if live.is_empty() {
            self.last = None;
            return false;
        }
        self.last = Some(clock);
        for l in live.values_mut() {
            let pose = l.motion.pose(l.mood, l.hovered);
            l.motion.advance(pose, dt);
        }
        self.frame += 1;
        true
    }

    pub fn hover(&mut self, key: &str, on: bool) {
        if let Some(l) = self.live.get_mut().get_mut(key) {
            l.hovered = on;
        }
    }

    pub fn poke(&mut self, key: &str) {
        if let Some(l) = self.live.get_mut().get_mut(key) {
            l.motion.poke();
        }
    }

    /// The bloub `owner` wears: its saved one, else, for a specialist, the one its id rolls.
    /// ky without a saved one has none here.
    pub fn spec(&self, owner: &str) -> Option<Spec> {
        if let Some(spec) = self.saved.get(owner) {
            return Some(spec.clone());
        }
        if owner == KY {
            return None;
        }
        Some(self.rolled.borrow_mut().entry(owner.to_string()).or_insert_with(|| roll(owner)).clone())
    }

    /// What to draw for the avatar keyed `key`: its motion's frame when animated (registering it),
    /// or `mood`'s still pose.
    fn frame_of(&self, key: &str, seed: &str, mood: Mood, animated: bool) -> Still {
        if !animated || self.reduced.get() {
            let t = phase_of(seed);
            return Still { d: settled(mood), t, blink: 0.0, hearts: Vec::new() };
        }
        let mut live = self.live.borrow_mut();
        let view = self.view.get();
        let l = live.entry(key.to_string()).or_insert_with(|| {
            if !self.fresh.replace(true) {
                if let Some(wake) = &self.wake {
                    wake();
                }
            }
            Live { motion: Motion::new(mood, seed), mood, hovered: false, stamp: view }
        });
        l.mood = mood;
        l.stamp = view;
        Still { d: l.motion.d, t: l.motion.t, blink: l.motion.blink(), hearts: l.motion.hearts.clone() }
    }
}

/// One frame's worth of motion, for drawing.
struct Still {
    d: Drawn,
    t: f64,
    blink: f32,
    hearts: Vec<f64>,
}

// ---------------------------------------------------------------------------------------------
// Drawing

/// An avatar: `owner`'s bloub at `size` points, keyed `key` for its motion. Animated unless
/// `still`; it hops under the pointer, and a click pokes it when `pokeable`.
pub struct Avatar<'a> {
    pub key: &'a str,
    pub spec: &'a Spec,
    pub seed: &'a str,
    pub mood: Mood,
    pub size: f32,
    pub still: bool,
    pub pokeable: bool,
}

pub fn avatar(blobs: &Blobs, a: Avatar) -> El {
    let animated = !a.still;
    let f = blobs.frame_of(a.key, a.seed, a.mood, animated);
    let mut e = canvas(draw(a.spec, &f, a.size)).key(&format!("bloub:{}", a.key)).size(a.size, a.size).label(&match a.mood {
        Mood::Working => format!("{} is working", a.seed),
        _ => a.seed.to_string(),
    });
    if animated {
        let key = a.key.to_string();
        e = e.on_hover_change(move |s: &mut crate::State, on, _| s.blobs.hover(&key, on));
        if a.pokeable {
            let key = a.key.to_string();
            e = e.on_press(move |s: &mut crate::State| s.blobs.poke(&key));
        }
    }
    e
}

/// `owner`'s avatar ("ky" or a specialist's id) at `size`, keyed `key` on screen. ky without a
/// saved bloub wears its mark.
pub fn of(s: &crate::State, owner: &str, key: &str, size: f32, mood: Mood, still: bool, p: &crate::theme::Palette) -> El {
    let Some(spec) = s.blobs.spec(owner) else { return crate::shell::mark(p) };
    let seed = if owner == KY { s.ky.as_ref().map_or(KY, |k| k.name.as_str()) } else { owner };
    avatar(&s.blobs, Avatar { key, spec: &spec, seed, mood, size, still, pokeable: false })
}

/// The bloubs an avatar tool offered, numbered as ky refers to them, each with its name.
pub fn options(s: &crate::State, specs: &[Spec], call: &str, p: &crate::theme::Palette) -> El {
    let mut line = rune::row().gap(14.0).pt(6.0).pb(4.0).flex_wrap();
    for (i, spec) in specs.iter().enumerate() {
        let caption = match &spec.name {
            Some(name) => format!("{} · {name}", i + 1),
            None => format!("{}", i + 1),
        };
        let key = format!("{call}:{i}");
        let seed = spec.name.clone().unwrap_or_else(|| key.clone());
        line = line.child(
            rune::col()
                .gap(4.0)
                .items_center()
                .child(avatar(&s.blobs, Avatar { key: &key, spec, seed: &seed, mood: Mood::Idle, size: 72.0, still: false, pokeable: true }))
                .child(rune::text(caption).font(crate::theme::META).color(p.muted)),
        );
    }
    line
}

/// sRGB bytes of `#rrggbb`.
fn bytes(hex: &str) -> [u8; 3] {
    let n = u32::from_str_radix(hex.get(1..7).unwrap_or("000000"), 16).unwrap_or(0);
    [(n >> 16) as u8, (n >> 8) as u8, n as u8]
}

fn color(hex: &str) -> Color {
    rune::color::hex(hex).unwrap_or(Color::BLACK)
}

/// The web's `shade`: each sRGB channel times `k`.
fn shade(hex: &str, k: f32) -> Color {
    let [r, g, b] = bytes(hex).map(|c| (c as f32 * k).round() as u8);
    color(&format!("#{r:02x}{g:02x}{b:02x}"))
}

fn is_light(hex: &str) -> bool {
    let [r, g, b] = bytes(hex).map(f32::from);
    0.3 * r + 0.59 * g + 0.11 * b > 180.0
}

/// A 2-D affine map, SVG's `matrix(a b c d e f)`.
#[derive(Clone, Copy, Debug)]
struct Affine([f32; 6]);

impl Affine {
    fn then(self, o: Affine) -> Affine {
        let [a, b, c, d, e, f] = self.0;
        let [oa, ob, oc, od, oe, of] = o.0;
        Affine([a * oa + c * ob, b * oa + d * ob, a * oc + c * od, b * oc + d * od, a * oe + c * of + e, b * oe + d * of + f])
    }
    fn translate(self, x: f32, y: f32) -> Affine {
        self.then(Affine([1.0, 0.0, 0.0, 1.0, x, y]))
    }
    fn rotate(self, degrees: f32) -> Affine {
        let (s, c) = degrees.to_radians().sin_cos();
        self.then(Affine([c, s, -s, c, 0.0, 0.0]))
    }
    fn scale(self, sx: f32, sy: f32) -> Affine {
        self.then(Affine([sx, 0.0, 0.0, sy, 0.0, 0.0]))
    }
    fn at(&self, [x, y]: [f32; 2]) -> [f32; 2] {
        let [a, b, c, d, e, f] = self.0;
        [a * x + c * y + e, b * x + d * y + f]
    }
    /// How much it scales lengths, near enough for a stroke's width.
    fn stretch(&self) -> f32 {
        let [a, b, c, d, ..] = self.0;
        ((a * d - b * c).abs()).sqrt()
    }
}

/// Draws in a bloub's own units under a transform onto the element's points.
struct Pen {
    shape: Shape,
    m: Affine,
}

impl Pen {
    fn fill(&mut self, points: Vec<[f32; 2]>, c: Color) {
        let mapped: Vec<[f32; 2]> = points.into_iter().map(|p| self.m.at(p)).collect();
        self.shape = std::mem::take(&mut self.shape).fill(mapped, c);
    }

    fn fill_path(&mut self, path: Path, c: Color) {
        self.shape = std::mem::take(&mut self.shape).fill_path(&path, c);
    }

    fn stroke_path(&mut self, path: Path, width: f32, c: Color) {
        let w = width * self.m.stretch();
        self.shape = std::mem::take(&mut self.shape).stroke_path(&path, w, LineCap::Round, c);
    }

    fn ellipse(&mut self, cx: f32, cy: f32, rx: f32, ry: f32, c: Color) {
        self.fill(ellipse(cx, cy, rx, ry, 0.0), c);
    }

    fn circle(&mut self, cx: f32, cy: f32, r: f32, c: Color) {
        self.ellipse(cx, cy, r, r, c);
    }

    /// A path in the pen's units, its points mapped as they're added.
    fn path(&self) -> Pencil {
        Pencil { path: Path::new(), m: self.m, at: [0.0, 0.0] }
    }
}

/// A path whose points (SVG's absolute and relative commands) map onto the element's points.
struct Pencil {
    path: Path,
    m: Affine,
    at: [f32; 2],
}

impl Pencil {
    fn m(mut self, p: [f32; 2]) -> Pencil {
        self.at = p;
        self.path = self.path.move_to(self.m.at(p));
        self
    }
    fn l(mut self, p: [f32; 2]) -> Pencil {
        self.at = p;
        self.path = self.path.line_to(self.m.at(p));
        self
    }
    fn q(mut self, c: [f32; 2], p: [f32; 2]) -> Pencil {
        self.at = p;
        self.path = self.path.quad_to(self.m.at(c), self.m.at(p));
        self
    }
    /// `q` relative to where the pencil is.
    fn qr(self, c: [f32; 2], p: [f32; 2]) -> Pencil {
        let [x, y] = self.at;
        self.q([x + c[0], y + c[1]], [x + p[0], y + p[1]])
    }
    fn c(mut self, c1: [f32; 2], c2: [f32; 2], p: [f32; 2]) -> Pencil {
        self.at = p;
        self.path = self.path.cubic_to(self.m.at(c1), self.m.at(c2), self.m.at(p));
        self
    }
    fn close(self) -> Path {
        self.path.close()
    }
    fn done(self) -> Path {
        self.path
    }
}

fn ellipse(cx: f32, cy: f32, rx: f32, ry: f32, degrees: f32) -> Vec<[f32; 2]> {
    let n = ((rx.max(ry) * 1.2) as usize).clamp(16, 64);
    let (s, c) = degrees.to_radians().sin_cos();
    (0..n)
        .map(|i| {
            let a = i as f32 / n as f32 * std::f32::consts::TAU;
            let (x, y) = (rx * a.cos(), ry * a.sin());
            [cx + x * c - y * s, cy + x * s + y * c]
        })
        .collect()
}

fn rounded_rect(x: f32, y: f32, w: f32, h: f32, r: f32) -> Vec<[f32; 2]> {
    let r = r.max(0.0).min(w / 2.0).min(h / 2.0);
    let corners = [(x + w - r, y + r, -90.0f32), (x + w - r, y + h - r, 0.0), (x + r, y + h - r, 90.0), (x + r, y + r, 180.0)];
    let steps = ((r * 0.6) as usize).clamp(1, 16);
    let mut points = Vec::new();
    for (cx, cy, from) in corners {
        if r < 0.01 {
            points.push([cx, cy]);
            continue;
        }
        for i in 0..=steps {
            let a = (from + 90.0 * i as f32 / steps as f32).to_radians();
            points.push([cx + r * a.cos(), cy + r * a.sin()]);
        }
    }
    points
}

/// The cap of the circle at (`cx`, `cy`) above the line `y = cut`: an eyelid.
fn cap(cx: f32, cy: f32, r: f32, cut: f32) -> Vec<[f32; 2]> {
    let s = ((cut - cy) / r).clamp(-1.0, 1.0);
    let (from, to) = (std::f32::consts::PI - s.asin(), std::f32::consts::TAU + s.asin());
    let n = 24;
    (0..=n)
        .map(|i| {
            let a = from + (to - from) * i as f32 / n as f32;
            [cx + r * a.cos(), cy + r * a.sin()]
        })
        .collect()
}

/// The sizes and colours every part is drawn from, worked out once per frame.
struct Frame<'a> {
    spec: &'a Spec,
    f: &'a Still,
    hw: f32,
    hh: f32,
    edge: Color,
    ink: Color,
    light: bool,
    body: Color,
}

/// One frame of `spec` at `size` points: the web's 160-unit viewBox from (-80, -88).
fn draw(spec: &Spec, f: &Still, size: f32) -> Shape {
    let k = size / 160.0;
    let light = is_light(&spec.body.color);
    let fr = Frame {
        spec,
        f,
        hw: spec.body.w / 2.0,
        hh: spec.body.h / 2.0,
        edge: shade(&spec.body.color, if light { 0.78 } else { 0.68 }),
        ink: color(if light { "#4a3a30" } else { "#2a0c0e" }),
        light,
        body: color(&spec.body.color),
    };
    let base = Affine([k, 0.0, 0.0, k, 80.0 * k, 88.0 * k]);
    let mut pen = Pen { shape: Shape::new(), m: base };
    let (hw, hh) = (fr.hw, fr.hh);
    let p = f.d.p;
    let t = f.t as f32;
    let wave = (t * p.rate).sin();
    let hopping = p.hop * (t * 7.0).sin().abs();
    let bob = wave * p.bob - hopping * 9.0 + p.sag * 4.0;
    // A click squashes it flat and lets it spring back; a hop stretches it.
    let squash = wave * 0.015 + p.sag * 0.05 - hopping * 0.03 + f.d.squish * (t * 26.0).cos() * 0.12;
    let tilt = p.tilt + p.dizzy * (t * 9.0).sin() * 8.0;
    let sway = (t * 1.7).sin() * 7.0 - tilt * 1.5;

    if spec.feet {
        for side in [-1.0, 1.0] {
            pen.ellipse(side * hw * 0.45, hh + 4.0, hw * 0.26, 8.0, fr.edge);
        }
    }
    let body = base.translate(0.0, bob).translate(0.0, hh).rotate(tilt).scale(1.0 + squash, 1.0 - squash).translate(0.0, -hh);
    pen.m = body.translate(0.0, -hh).rotate(sway).translate(0.0, hh);
    top(&mut pen, &fr);
    pen.m = body;
    pen.fill(rounded_rect(-hw - 2.5, -hh - 2.5, spec.body.w + 5.0, spec.body.h + 5.0, spec.body.corner + 2.5), fr.edge);
    pen.fill(rounded_rect(-hw + 2.5, -hh + 2.5, spec.body.w - 5.0, spec.body.h - 5.0, spec.body.corner - 2.5), fr.body);
    pen.ellipse(-hw * 0.45, -hh * 0.72, hw * 0.28, 6.0, Color::WHITE.alpha(if light { 0.6 } else { 0.3 }));
    face(&mut pen, &fr);
    pen.m = base;
    afloat(&mut pen, &fr);
    pen.shape
}

fn face(pen: &mut Pen, fr: &Frame) {
    let p = fr.f.d.p;
    let (count, r) = (fr.spec.eyes.count, fr.spec.eyes.size);
    let lid = p.lid.max(fr.f.blink);
    let mouth_y = fr.hh * 0.42;
    let cheek_x = (if count == 1 { r + 12.0 } else { r * 2.55 + 2.0 }).min(fr.hw - 12.0);
    let xs: &[f32] = if count == 1 { &[0.0] } else { &[-r * 1.55, r * 1.55] };
    for x in xs {
        eye(pen, fr, *x, -fr.hh * 0.12, r, lid);
    }
    if fr.spec.cheeks {
        let pink = color("#ff8fa3").alpha((0.55 + p.blush * 0.35) * (1.0 - p.sag));
        for side in [-1.0, 1.0] {
            pen.ellipse(side * cheek_x, mouth_y - 4.0, 9.0, 5.5, pink);
        }
    }
    mouth(pen, mouth_y, &p, fr.ink);
}

fn eye(pen: &mut Pen, fr: &Frame, x: f32, y: f32, r: f32, lid: f32) {
    let d = fr.f.d;
    let p = d.p;
    let pr = r * 0.58;
    let px = x + d.gx * (r - pr - 2.0);
    let py = y + d.gy * (r - pr - 2.0);
    let o = 1.0 - p.happy.max(p.dizzy);
    if o > 0.01 {
        pen.circle(x, y, r, Color::WHITE.alpha(o));
        pen.circle(px, py, pr, color("#1b1b1f").alpha(o));
        pen.circle(px - pr * 0.35, py - pr * 0.4, pr * 0.34, Color::WHITE.alpha(o));
        pen.circle(px + pr * 0.38, py + pr * 0.35, pr * 0.15, Color::WHITE.alpha(o));
        if lid > 0.005 {
            pen.fill(cap(x, y, r + 0.3, y - r + 2.0 * r * lid), fr.body.alpha(o));
        }
    }
    // Happy eyes: a ^ arc, the cutest thing one stroke can do.
    if p.happy > 0.05 {
        let arc = pen.path().m([x - r * 0.7, y + r * 0.25]).q([x, y - r * 0.75], [x + r * 0.7, y + r * 0.25]).done();
        pen.stroke_path(arc, (r * 0.28).max(4.0), fr.ink.alpha(p.happy));
    }
    // Dizzy eyes: a spiral that spins.
    if p.dizzy > 0.05 {
        let turn = ((fr.f.t * 540.0) % 360.0) as f32;
        let m = pen.m.translate(x, y).rotate(turn);
        let mut points = Vec::new();
        // Three half-turns, each smaller: SVG's `a` arcs from the web's spiral.
        for (cx, rr, from) in [(0.0, 0.6, 180.0f32), (0.2, 0.4, 0.0), (0.0, 0.2, 180.0)] {
            for i in 0..=12 {
                let a = (from + 180.0 * i as f32 / 12.0).to_radians();
                points.push(m.at([cx * r + rr * r * a.cos(), rr * r * a.sin()]));
            }
        }
        let w = (r * 0.18).max(3.0) * m.stretch();
        pen.shape = std::mem::take(&mut pen.shape).stroke(points, w, fr.ink.alpha(p.dizzy));
    }
}

fn mouth(pen: &mut Pen, y: f32, p: &Params, ink: Color) {
    let w = 9.0;
    if p.open > 0.05 {
        let path = pen.path().m([-w, y]).q([0.0, y + 2.0], [w, y]).q([0.0, y + 6.0 + p.open * 10.0], [-w, y]).close();
        pen.fill_path(path, ink);
        return;
    }
    let corner = y + (-p.smile).max(0.0) * 5.0;
    let path = pen.path().m([-w, corner]).q([0.0, y + p.smile * 9.0], [w, corner]).done();
    pen.stroke_path(path, 4.5, ink);
}

/// What sits on top, by kind; it sways with the body.
fn top(pen: &mut Pen, fr: &Frame) {
    let spec = fr.spec;
    let hex = spec.top.color.as_deref().unwrap_or(&spec.body.color);
    let c = color(hex);
    let y = -fr.hh;
    match spec.top.kind {
        TopKind::None => {}
        TopKind::Antenna => {
            let stalk = pen.path().m([0.0, y + 4.0]).l([0.0, y - 14.0]).done();
            pen.stroke_path(stalk, 5.0, shade(&spec.body.color, 0.62));
            pen.circle(0.0, y - 19.0, 8.0, c);
        }
        TopKind::Leaf => {
            let leaf = pen.path().m([0.0, y + 4.0]).qr([-2.0, -10.0], [4.0, -16.0]).qr([14.0, -6.0], [22.0, 0.0]).qr([-8.0, 14.0], [-26.0, 16.0]).close();
            pen.fill_path(leaf, c);
        }
        TopKind::Ears => {
            for side in [-1.0, 1.0] {
                let x = side * fr.hw * 0.55;
                pen.fill(ellipse(x, y + 6.0, 15.0, 20.0, side * 18.0), fr.edge);
                pen.fill(ellipse(x, y + 6.0, 11.0, 16.0, side * 18.0), c);
            }
        }
        TopKind::Sprout => {
            let stalk = pen.path().m([0.0, y + 4.0]).l([0.0, y - 12.0]).done();
            pen.stroke_path(stalk, 4.0, shade(hex, 0.7));
            for side in [-1.0, 1.0] {
                let leaf = pen.path().m([0.0, y - 10.0]).qr([side * -4.0, -12.0], [side * -16.0, -12.0]).qr([side * 2.0, 12.0], [side * 16.0, 12.0]).close();
                pen.fill_path(leaf, c);
            }
        }
        TopKind::Tuft => {
            for dx in [-8.0f32, 0.0, 8.0] {
                let hair = pen.path().m([dx, y + 4.0]).qr([dx * 0.6 - 3.0, -12.0], [dx * 0.9 + 4.0, -16.0]).done();
                pen.stroke_path(hair, 5.0, c);
            }
        }
    }
}

/// Working dots, a sweat drop, and hearts from clicks.
fn afloat(pen: &mut Pen, fr: &Frame) {
    let p = fr.f.d.p;
    let (hw, hh) = (fr.hw, fr.hh);
    let t = fr.f.t as f32;
    if p.dots > 0.02 {
        for i in 0..3 {
            let k = ((t * 6.0 - i as f32 * 0.9).sin() + 1.0) / 2.0;
            pen.circle(hw + 2.0 + i as f32 * 11.0, -hh - 10.0 - k * 5.0, 3.5 + k * 1.8, fr.body.alpha(p.dots * (0.35 + k * 0.65)));
        }
    }
    if p.drop > 0.02 {
        let fall = (t * 12.0) % 8.0;
        let drop = pen.path().m([hw - 6.0, -hh + 4.0 + fall]).qr([-7.0, 11.0], [0.0, 14.0]).qr([7.0, -3.0], [0.0, -14.0]).close();
        pen.fill_path(drop, color("#7cc4ff").alpha(p.drop));
    }
    let base = pen.m;
    for born in &fr.f.hearts {
        let age = ((fr.f.t - born) / HEART_LIFE) as f32;
        pen.m = base.translate(hw * 0.6 + (age * 9.0).sin() * 4.0, -hh - 6.0 - age * 30.0).scale(0.8 + age * 0.5, 0.8 + age * 0.5);
        let heart = pen.path().m([0.0, 4.0]).c([-9.0, -3.0], [-6.0, -11.0], [0.0, -6.0]).c([6.0, -11.0], [9.0, -3.0], [0.0, 4.0]).close();
        pen.fill_path(heart, color("#ff5d8f").alpha((1.0 - age).max(0.0)));
    }
    pen.m = base;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(json: &str) -> Spec {
        Spec::read(&serde_json::from_str(json).unwrap()).unwrap()
    }

    #[test]
    fn a_specialist_rolls_the_bloub_the_web_rolls() {
        // From the web's rollSpec (src/avatars/contract.ts), run in node.
        let want = [
            ("researcher", r##"{"body":{"w":119,"h":91,"corner":29,"color":"#b48cff"},"eyes":{"count":2,"size":16},"top":{"kind":"sprout","color":"#ffc93c"},"cheeks":true,"feet":false}"##),
            ("writer", r##"{"body":{"w":91,"h":116,"corner":40,"color":"#b48cff"},"eyes":{"count":1,"size":23},"top":{"kind":"leaf","color":"#ff5d5d"},"cheeks":true,"feet":true}"##),
            ("", r##"{"body":{"w":108,"h":104,"corner":27,"color":"#22b8a6"},"eyes":{"count":2,"size":16},"top":{"kind":"sprout","color":"#3cc46a"},"cheeks":false,"feet":true}"##),
            ("é🙂x", r##"{"body":{"w":113,"h":106,"corner":36,"color":"#f4ece0"},"eyes":{"count":1,"size":28},"top":{"kind":"leaf","color":"#ffc93c"},"cheeks":true,"feet":true}"##),
        ];
        for (seed, json) in want {
            assert_eq!(roll(seed), spec(json), "{seed:?}");
        }
    }

    #[test]
    fn previews_come_from_the_fenced_block_only() {
        let out = "Two options.\n```bloubs\n[{\"name\":\"Pip\",\"body\":{\"w\":108,\"h\":108,\"corner\":54,\"color\":\"#3d8bff\"},\"eyes\":{\"count\":2,\"size\":15},\"top\":{\"kind\":\"leaf\",\"color\":\"#3cc46a\"},\"cheeks\":true,\"feet\":true}]\n```\nPick one.";
        let got = previews(out);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name.as_deref(), Some("Pip"));
        assert!(previews("no fence here").is_empty());
        assert!(previews("```bloubs\n[{\"body\":1}]\n```").is_empty());
    }

    #[test]
    fn a_bad_spec_is_not_drawn() {
        let bad = r##"{"body":{"w":100,"h":100,"corner":10,"color":"red"},"eyes":{"count":2,"size":12},"top":{"kind":"none"},"cheeks":true,"feet":true}"##;
        assert!(Spec::read(&serde_json::from_str(bad).unwrap()).is_none());
        let three = r##"{"body":{"w":100,"h":100,"corner":10,"color":"#ff0000"},"eyes":{"count":3,"size":12},"top":{"kind":"none"},"cheeks":true,"feet":true}"##;
        assert!(Spec::read(&serde_json::from_str(three).unwrap()).is_none());
    }

    #[test]
    fn five_quick_pokes_make_it_dizzy_and_it_settles() {
        let mut m = Motion::new(Mood::Idle, "pip");
        for _ in 0..5 {
            m.poke();
            m.advance(Pose::Idle, 0.05);
        }
        assert_eq!(m.pose(Mood::Idle, false), Pose::Dizzy);
        for _ in 0..80 {
            m.advance(m.pose(Mood::Idle, false), 0.05);
        }
        assert_eq!(m.pose(Mood::Idle, false), Pose::Idle);
        assert!(m.hearts.is_empty());
    }

    #[test]
    fn an_avatar_not_drawn_by_the_latest_view_stops_stepping() {
        let mut blobs = Blobs::default();
        blobs.begin(false);
        blobs.frame_of("a", "pip", Mood::Idle, true);
        assert!(blobs.fresh.get());
        assert!(blobs.step(0.0));
        blobs.begin(false);
        assert!(!blobs.step(0.016));
        assert!(blobs.live.borrow().is_empty());
    }
}
