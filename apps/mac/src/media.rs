//! Images, as the web sends and shows them (`src/ui/pick-images.ts`, `use-draft.ts`, `Thread.tsx`,
//! `Lightbox.tsx`): picked, pasted or dropped into the composer, made small enough to send, sent
//! inline as base64 `image` parts of `submit`, drawn in the thread, and opened full size.

use std::sync::Arc;

use base64::Engine;
use rune::{El, SurfaceFit, col, el, icon, row, text};

use crate::theme::{META, Palette, TITLE, icons};
use crate::{State, Tab};

/// The web's limits (`src/files/media.ts`): four images a message, each under a quarter of the
/// message's 1.4M base64 characters, none longer than 1568px on a side.
pub const MAX_IMAGES: usize = 4;
const MAX_SIDE: u32 = 1568;
const IMAGE_CHARS: usize = 1_400_000 / MAX_IMAGES;

/// What the file picker offers.
pub const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// An image in the composer, ready to send.
#[derive(Clone)]
pub struct Picked {
    pub id: u64,
    pub name: String,
    pub mime: String,
    /// Base64, no `data:` prefix: what `submit` carries.
    pub data: String,
    pub bytes: Arc<[u8]>,
}

/// `bytes` as ky takes an image: as it is when it's small enough and a type the model reads, or
/// scaled to fit 1568px and re-encoded as JPEG, smaller each try, until it fits (the web's
/// `prepareImage`). The words are the web's.
pub fn prepare(name: &str, bytes: &[u8]) -> Result<(String, Vec<u8>), String> {
    let shown = if name.is_empty() { "That file" } else { name };
    let format = image::guess_format(bytes).map_err(|_| format!("{shown} isn't an image ky can read."))?;
    let decoded = image::load_from_memory_with_format(bytes, format).map_err(|_| format!("{shown} isn't an image ky can read."))?;
    let (w, h) = (decoded.width(), decoded.height());
    let mime = match format {
        image::ImageFormat::Png => Some("image/png"),
        image::ImageFormat::Jpeg => Some("image/jpeg"),
        _ => None,
    };
    // PNG and JPEG pass as they are; the window draws those two, and ky takes them.
    if let Some(mime) = mime {
        if w.max(h) <= MAX_SIDE && bytes.len() * 137 / 100 <= IMAGE_CHARS {
            return Ok((mime.to_string(), bytes.to_vec()));
        }
    }
    // JPEG has no alpha: lay the image on white first.
    let rgba = decoded.to_rgba8();
    let mut flat = image::RgbImage::new(w, h);
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        flat.put_pixel(x, y, image::Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }
    let mut scale = (MAX_SIDE as f32 / w.max(h) as f32).min(1.0);
    for _ in 0..6 {
        let (sw, sh) = (((w as f32 * scale).round() as u32).max(1), ((h as f32 * scale).round() as u32).max(1));
        let sized = if (sw, sh) == (w, h) { flat.clone() } else { image::imageops::resize(&flat, sw, sh, image::imageops::FilterType::CatmullRom) };
        for quality in [85u8, 72, 60] {
            let mut out = Vec::new();
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
            if sized.write_with_encoder(encoder).is_err() {
                return Err("Could not encode the image.".into());
            }
            if out.len().div_ceil(3) * 4 <= IMAGE_CHARS {
                return Ok(("image/jpeg".into(), out));
            }
        }
        scale *= 0.75;
    }
    Err(format!("{} is too large to send.", if name.is_empty() { "image" } else { name }))
}

pub fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn decode(data: &str) -> Option<Arc<[u8]>> {
    base64::engine::general_purpose::STANDARD.decode(data.trim()).ok().map(Arc::from)
}

/// The lightbox: the images of one message, and which one shows.
pub struct Lightbox {
    pub images: Vec<Arc<[u8]>>,
    pub at: usize,
    pub label: String,
}

impl State {
    /// Attach image files to the open chat's draft, preparing them off the UI thread.
    pub fn attach_paths(&mut self, paths: &[std::path::PathBuf]) {
        for path in paths {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            match std::fs::read(path) {
                Ok(bytes) => self.attach_bytes(&name, bytes),
                Err(_) => self.image_problem(format!("Could not read {name}.")),
            }
        }
    }

    pub fn attach_bytes(&mut self, name: &str, bytes: Vec<u8>) {
        let Some(Tab::Chat(session)) = self.current().cloned() else { return };
        let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) else { return };
        if conn.images.len() + conn.preparing >= MAX_IMAGES {
            conn.image_error = Some(format!("Attach at most {MAX_IMAGES} images."));
            return;
        }
        conn.image_error = None;
        conn.preparing += 1;
        self.picked += 1;
        let (id, name, tx, waker) = (self.picked, name.to_string(), self.media.0.clone(), self.wake.clone());
        std::thread::spawn(move || {
            let result = prepare(&name, &bytes).map(|(mime, out)| {
                let data = encode(&out);
                Picked { id, name: if name.is_empty() { format!("Image {id}") } else { name }, mime, data, bytes: Arc::from(out) }
            });
            let _ = tx.send((session, result));
            waker();
        });
    }

    fn image_problem(&mut self, why: String) {
        let Some(Tab::Chat(session)) = self.current().cloned() else { return };
        if let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) {
            conn.image_error = Some(why);
        }
    }

    /// Prepared images land in their chat's draft.
    pub fn land_images(&mut self) -> bool {
        let mut changed = false;
        while let Ok((session, result)) = self.media.1.try_recv() {
            changed = true;
            let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) else { continue };
            conn.preparing = conn.preparing.saturating_sub(1);
            match result {
                Ok(picked) => conn.images.push(picked),
                Err(why) => conn.image_error = Some(why),
            }
        }
        changed
    }

    pub fn unattach(&mut self, id: u64) {
        let Some(Tab::Chat(session)) = self.current().cloned() else { return };
        if let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) {
            conn.images.retain(|i| i.id != id);
            conn.image_error = None;
        }
    }

    /// Open the file picker for images.
    pub fn pick_images(&mut self, tx: &mut rune::Tx) {
        let options = rune::FileDialogOptions { title: "Attach images".into(), ..Default::default() }.filter("Images", EXTENSIONS);
        tx.open_file(options, |s: &mut State, result, _| match result {
            Ok(Some(path)) => s.attach_paths(&[path]),
            Ok(None) => {}
            Err(e) => s.image_problem(e.to_string()),
        });
    }

    pub fn open_lightbox(&mut self, images: Vec<Arc<[u8]>>, at: usize) {
        self.open_pictures(images, at, "Image you sent");
    }

    /// The lightbox on pictures ky showed, named `label`.
    pub fn open_pictures(&mut self, images: Vec<Arc<[u8]>>, at: usize, label: &str) {
        self.lightbox = Some(Lightbox { images, at, label: label.to_string() });
    }

    pub fn step_lightbox(&mut self, by: isize) {
        if let Some(lb) = &mut self.lightbox {
            let n = lb.images.len() as isize;
            if n > 0 {
                lb.at = ((lb.at as isize + by).rem_euclid(n)) as usize;
            }
        }
    }
}

/// The composer's row of images to send, each with its remove button.
pub fn pending(s: &State, images: &[Picked], preparing: usize, p: &Palette) -> El {
    let mut strip = row().key("composer-images").label("Images to send").gap(8.0).pt(10.0).pl(12.0);
    for image in images {
        let id = image.id;
        let shown = s.images.load(image.bytes.clone());
        strip = strip.child(
            el().key(&format!("pending-image:{id}"))
                .size(64.0, 64.0)
                .child(el().size(64.0, 64.0).radius(12.0).border(1.0, p.line).pixels_fit(shown.pixels(), SurfaceFit::Fill).clip_rounded(12.0))
                .child(
                    el().key(&format!("remove-image:{id}"))
                        .role("button")
                        .label(&format!("Remove {}", image.name))
                        .pin(None, Some(-6.0), Some(-6.0), None)
                        .size(20.0, 20.0)
                        .radius(10.0)
                        .fill(p.ink)
                        .center()
                        .child(icon(&icons::CLOSE, 10.0).color(p.bg))
                        .on_press(move |s: &mut State| s.unattach(id)),
                ),
        );
    }
    for i in 0..preparing {
        strip = strip.child(el().key(&format!("preparing:{i}")).size(64.0, 64.0).radius(12.0).fill(p.sunken).border(1.0, p.line).center().child(text("…").font(TITLE).color(p.quiet)));
    }
    strip
}

/// The images a user message carried, above its bubble; each opens the lightbox.
pub fn sent(s: &State, key: &str, images: &[Arc<[u8]>], p: &Palette) -> El {
    let n = images.len();
    let side = if n == 1 { 240.0 } else { 120.0 };
    let mut out = row().w_full().justify_end().gap(6.0).flex_wrap();
    for (i, bytes) in images.iter().enumerate() {
        let shown = s.images.load(bytes.clone());
        let all = images.to_vec();
        let mut tile = el()
            .key(&format!("{key}:image:{i}"))
            .role("button")
            .label(&format!("Open Image {} you sent", i + 1))
            .radius(14.0)
            .border(1.0, p.line)
            .clip_rounded(14.0)
            .on_press(move |s: &mut State| s.open_lightbox(all.clone(), i));
        tile = match (n, shown.size()) {
            // One image keeps its shape, up to the side; several tile as squares.
            (1, Some([w, h])) if w > 0 && h > 0 => {
                let k = (side / w.max(h) as f32).min(1.0);
                tile.size((w as f32 * k).max(48.0), (h as f32 * k).max(48.0)).pixels_fit(shown.pixels(), SurfaceFit::Fill)
            }
            _ => tile.size(side, side).fill(p.sunken).pixels_fit(shown.pixels(), SurfaceFit::Fill),
        };
        out = out.child(tile);
    }
    out
}

/// The lightbox over the window: the image fit to the window, its place among the message's,
/// Previous and Next, and Close. Esc closes, ← and → step (`keys` in main.rs).
pub fn lightbox(s: &State, _p: &Palette, layer: &mut Vec<El>) {
    let Some(lb) = &s.lightbox else { return };
    let Some(bytes) = lb.images.get(lb.at) else { return };
    let shown = s.images.load(bytes.clone());
    let n = lb.images.len();
    let scrim = rune::Color { a: 0.94, ..rune::color::hex("#0b0b0c").expect("a colour") };
    let white = rune::color::hex("#f4f4f5").expect("a colour");
    let round = |key: &str, label: &str, glyph: El| el().key(key).role("button").label(label).size(36.0, 36.0).radius(18.0).fill(rune::Color { a: 0.14, ..white }).center().child(glyph);
    let mut bar = row().w_full().px(20.0).py(14.0).gap(12.0).center_y().child(text(lb.label.clone()).font(META).color(white).grow(1.0));
    if n > 1 {
        bar = bar.child(text(format!("{} / {}", lb.at + 1, n)).font(META).color(rune::Color { a: 0.7, ..white }));
    }
    bar = bar.child(round("lightbox-close", "Close", icon(&icons::CLOSE, 14.0).color(white)).on_press(|s: &mut State| s.lightbox = None));
    let mut stage = row().w_full().grow(1.0).min_h(0.0).px(24.0).pb(24.0).gap(16.0).center();
    if n > 1 {
        stage = stage.child(round("lightbox-previous", "Previous", text("‹").font(TITLE).color(white)).on_press(|s: &mut State| s.step_lightbox(-1)));
    }
    // Fit to the window, but never past the image's own size: a small image stays sharp.
    let mut picture = el().key(&format!("lightbox-image:{}", lb.at)).grow(1.0).h_full().min_w(0.0).pixels_fit(shown.pixels(), SurfaceFit::Fit);
    if let Some([w, h]) = shown.size() {
        picture = picture.max_w(w as f32).max_h(h as f32);
    }
    stage = stage.child(picture);
    if n > 1 {
        stage = stage.child(round("lightbox-next", "Next", text("›").font(TITLE).color(white)).on_press(|s: &mut State| s.step_lightbox(1)));
    }
    layer.push(el().key("lightbox-scrim").absolute(0.0, 0.0).w_full().h_full().fill(scrim).a11y_hidden());
    layer.push(
        col()
            .key("lightbox")
            .role("dialog")
            .label(&lb.label)
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .child(bar)
            .child(stage)
            .modal(true, |s: &mut State| s.lightbox = None),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x * 7 + y * 13) % 256) as u8, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn a_small_png_goes_as_it_is() {
        let bytes = png(40, 30);
        let (mime, out) = prepare("dot.png", &bytes).unwrap();
        assert_eq!((mime.as_str(), out), ("image/png", bytes));
    }

    #[test]
    fn a_big_image_fits_the_side_and_the_budget() {
        let (mime, out) = prepare("big.png", &png(3000, 2000)).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert!(encode(&out).len() <= IMAGE_CHARS);
        let back = image::load_from_memory(&out).unwrap();
        assert!(back.width().max(back.height()) <= MAX_SIDE);
    }

    #[test]
    fn not_an_image_says_so() {
        assert_eq!(prepare("notes.txt", b"hello").unwrap_err(), "notes.txt isn't an image ky can read.");
    }
}
