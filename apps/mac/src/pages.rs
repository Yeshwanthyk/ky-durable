//! A page ky built (`/s/<site>/?embed`), live in the chat as the web's iframe shows it: a WebKit view
//! laid over the card's place in the transcript. Rune draws into one Metal layer, so the web view is
//! a native view above it: each chat's transcript gets a clipping view where its scroll viewport is,
//! and each page sits inside that over its card, sized by the height the page reports.
//!
//! The views move in `place`, which the app's compositor calls while each frame is built, with
//! where that frame draws each card: a resize, a scroll or a spring moves the page in the same
//! frame as its card. (Moved from `on_drawn_layout`, which runs after the frame presents and waits
//! out springs, the page trailed its card by up to 290pt through a window resize.)
//!
//! Native views draw over everything Rune draws, so the pages hide whenever their chat isn't the one
//! showing or anything floats over the window (⌘K, the lightbox, a menu).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use rune::Waker;

/// The height a page shows at until it reports its own, as the web's block defaults.
pub const DEFAULT_HEIGHT: f32 = 480.0;

#[derive(Clone, Default)]
pub struct Pages(Rc<RefCell<Inner>>);

#[derive(Default)]
struct Inner {
    /// Each chat's clipping view, where its transcript's viewport is, and how far it's scrolled.
    clips: HashMap<String, Clip>,
    pages: HashMap<String, Page>,
    /// The chat showing, when nothing covers it.
    shown: Option<String>,
    /// Bumps when a page reports a new height: the turn showing it lays out again.
    rev: u64,
    /// A view was made since the last frame, and waits for one to place it.
    unplaced: bool,
    #[cfg(target_os = "macos")]
    store: Option<mac::Store>,
}

struct Clip {
    #[cfg(target_os = "macos")]
    view: Option<mac::View>,
}

struct Page {
    session: String,
    height: f32,
    #[cfg(target_os = "macos")]
    view: Option<mac::View>,
}

/// Where a page loads from and how it signs in.
pub struct Source {
    pub url: String,
    pub base: String,
    pub token: Option<String>,
}

impl Pages {
    pub fn rev(&self) -> u64 {
        self.0.borrow().rev
    }

    /// Whether a view made since the last poll needs a frame to be placed (taking the ask).
    pub fn wants_frame(&self) -> bool {
        self.0.try_borrow_mut().is_ok_and(|mut i| std::mem::take(&mut i.unplaced))
    }

    /// The height the page under `key` shows at.
    pub fn height(&self, key: &str) -> f32 {
        self.0.borrow().pages.get(key).map_or(DEFAULT_HEIGHT, |p| p.height)
    }

    /// Show the pages of `session`'s chat, or none (`None`: no chat showing, or something covers it).
    pub fn show(&self, session: Option<&str>) {
        let Ok(mut inner) = self.0.try_borrow_mut() else { return };
        if inner.shown.as_deref() == session {
            return;
        }
        inner.shown = session.map(str::to_string);
        inner.apply_shown();
    }

    /// Drop every page and clip, as when the window leaves its ky.
    pub fn clear(&self) {
        let Ok(mut inner) = self.0.try_borrow_mut() else { return };
        #[cfg(target_os = "macos")]
        for clip in inner.clips.values() {
            if let Some(v) = &clip.view {
                v.remove();
            }
        }
        inner.clips.clear();
        inner.pages.clear();
        inner.shown = None;
        inner.rev += 1;
    }

    /// The element key of `session`'s transcript, whose viewport the clip follows.
    pub fn transcript_key(session: &str) -> String {
        format!("transcript:{session}")
    }

    /// `session`'s transcript drew: give it a clipping view if it has none (placed next frame).
    pub fn viewport(&self, session: &str, wake: &Waker) {
        let Ok(mut inner) = self.0.try_borrow_mut() else { return };
        if inner.clips.contains_key(session) {
            return;
        }
        inner.clips.insert(
            session.to_string(),
            Clip {
                #[cfg(target_os = "macos")]
                view: mac::View::clip(),
            },
        );
        inner.apply_shown();
        inner.unplaced = true;
        wake();
    }

    /// The page `key` of `session`'s chat drew: make its web view if it has none (`place` puts it).
    pub fn drawn(&self, key: &str, session: &str, source: impl FnOnce() -> Source, wake: &Waker, dark: bool) {
        let Ok(mut inner) = self.0.try_borrow_mut() else { return };
        let Some(clip) = inner.clips.get(session) else { return };
        #[cfg(target_os = "macos")]
        let clip_view = clip.view.clone();
        #[cfg(not(target_os = "macos"))]
        let _ = clip;
        let fresh = !inner.pages.contains_key(key);
        if fresh {
            inner.pages.insert(
                key.to_string(),
                Page {
                    session: session.to_string(),
                    height: DEFAULT_HEIGHT,
                    #[cfg(target_os = "macos")]
                    view: None,
                },
            );
        }
        #[cfg(target_os = "macos")]
        if fresh {
            if let Some(clip_view) = clip_view {
                let source = source();
                let heights = Rc::downgrade(&self.0);
                let (key2, wake2) = (key.to_string(), wake.clone());
                let on_height = move |h: f64| {
                    let Some(inner) = heights.upgrade() else { return };
                    let Ok(mut inner) = inner.try_borrow_mut() else { return };
                    let h = (h as f32).clamp(80.0, 2000.0);
                    if let Some(p) = inner.pages.get_mut(&key2) {
                        if (p.height - h).abs() >= 1.0 {
                            p.height = h;
                            inner.rev += 1;
                            wake2();
                        }
                    }
                };
                let store = inner.store.get_or_insert_with(mac::Store::new).clone();
                let view = mac::View::page(&clip_view, &store, &source, dark, Box::new(on_height));
                // Hidden until the next frame's `place` puts it over its card.
                if let Some(v) = &view {
                    v.set_hidden(true);
                }
                if let Some(p) = inner.pages.get_mut(key) {
                    p.view = view;
                }
                inner.unplaced = true;
                wake();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (source, wake, dark);
    }

    /// Put the showing chat's clip and pages where this frame draws its transcript and their cards
    /// (`drawn`: an element's rect by key, window points). A page whose card isn't drawn (its turn
    /// scrolled out of the rows kept) hides.
    pub fn place(&self, drawn: impl Fn(&str) -> Option<[f32; 4]>) {
        #[cfg(target_os = "macos")]
        {
            let Ok(inner) = self.0.try_borrow() else { return };
            let Some(session) = inner.shown.as_deref() else { return };
            let Some(clip) = inner.clips.get(session).and_then(|c| c.view.as_ref()) else { return };
            let Some(port) = drawn(&Pages::transcript_key(session)) else { return };
            clip.place_in_window(port);
            for (key, p) in inner.pages.iter().filter(|(_, p)| p.session == session) {
                let Some(v) = &p.view else { continue };
                match drawn(key) {
                    Some(r) => {
                        v.place_in_clip([r[0] - port[0], r[1] - port[1], r[2], r[3]], port[3]);
                        v.set_hidden(false);
                    }
                    None => v.set_hidden(true),
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = drawn;
    }
}

impl Pages {
    /// `KY_PAGES_PROBE=1`: after each frame, how far each showing page's web view sits from where
    /// that frame drew its card, printed when it's off by half a point or more.
    pub fn probe(&self, drawn: impl Fn(&str) -> Option<[f32; 4]>) {
        #[cfg(target_os = "macos")]
        {
            let Ok(inner) = self.0.try_borrow() else { return };
            let Some(session) = inner.shown.as_deref() else { return };
            for (key, p) in inner.pages.iter().filter(|(_, p)| p.session == session) {
                let (Some(card), Some(v)) = (drawn(key), &p.view) else { continue };
                let Some(at) = v.in_window() else { continue };
                let off = (0..4).map(|i| (card[i] - at[i]).abs()).fold(0.0f32, f32::max);
                if off >= 0.5 {
                    eprintln!("pages-probe off {off:.1}pt card {card:?} view {at:?}");
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = drawn;
    }
}

impl Inner {
    fn apply_shown(&self) {
        #[cfg(target_os = "macos")]
        for (session, clip) in &self.clips {
            if let Some(v) = &clip.view {
                v.set_hidden(self.shown.as_deref() != Some(session.as_str()));
            }
        }
    }

}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::rc::Rc;

    use block2::RcBlock;
    use objc2::encode::{Encode, Encoding};
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, NSObject};
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_foundation::NSString;

    #[link(name = "WebKit", kind = "framework")]
    unsafe extern "C" {}

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct(
            "CGRect",
            &[Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]), Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING])],
        );
    }

    fn class(name: &str) -> &'static AnyClass {
        AnyClass::get(&std::ffi::CString::new(name).unwrap()).unwrap_or_else(|| panic!("no class {name}"))
    }

    fn string(s: &str) -> Retained<NSString> {
        NSString::from_str(s)
    }

    /// The window's content view, where Rune draws.
    fn content_view() -> Option<Retained<AnyObject>> {
        MainThreadMarker::new()?;
        unsafe {
            let app: Retained<AnyObject> = msg_send![class("NSApplication"), sharedApplication];
            let mut window: Option<Retained<AnyObject>> = msg_send![&*app, mainWindow];
            if window.is_none() {
                window = msg_send![&*app, keyWindow];
            }
            if window.is_none() {
                let all: Retained<AnyObject> = msg_send![&*app, windows];
                window = msg_send![&*all, firstObject];
            }
            msg_send![&*window?, contentView]
        }
    }

    /// The website data the pages share: ky's sign-in cookie, set once before the first load.
    #[derive(Clone)]
    pub struct Store(Rc<StoreInner>);

    struct StoreInner {
        data: Retained<AnyObject>,
        /// Whose cookie is set, and the loads waiting on it.
        cookie: RefCell<(Option<String>, bool, Vec<Box<dyn FnOnce()>>)>,
    }

    impl Store {
        pub fn new() -> Store {
            let data: Retained<AnyObject> = unsafe { msg_send![class("WKWebsiteDataStore"), nonPersistentDataStore] };
            Store(Rc::new(StoreInner { data, cookie: RefCell::new((None, false, Vec::new())) }))
        }

        /// Run `load` once the sign-in cookie for `base` is set (now, when there's none to set).
        fn signed_in(&self, base: &str, token: Option<&str>, load: Box<dyn FnOnce()>) {
            let Some(token) = token else { return load() };
            {
                let mut c = self.0.cookie.borrow_mut();
                if c.0.as_deref() == Some(base) {
                    if c.1 {
                        drop(c);
                        return load();
                    }
                    c.2.push(load);
                    return;
                }
                *c = (Some(base.to_string()), false, vec![load]);
            }
            let host = base.split("://").nth(1).unwrap_or(base).split(['/', ':']).next().unwrap_or_default();
            let secure = base.starts_with("https://");
            let cookie: Option<Retained<AnyObject>> = unsafe {
                let props: Retained<AnyObject> = msg_send![class("NSMutableDictionary"), new];
                let put = |k: &str, v: &str| {
                    let (k, v) = (string(k), string(v));
                    let _: () = msg_send![&*props, setObject: &*v, forKey: &*k];
                };
                put("Name", "CF_Authorization");
                put("Value", token);
                put("Domain", host);
                put("Path", "/");
                if secure {
                    put("Secure", "TRUE");
                }
                msg_send![class("NSHTTPCookie"), cookieWithProperties: &*props]
            };
            let me = self.0.clone();
            let done = RcBlock::new(move || {
                let waiting = {
                    let mut c = me.cookie.borrow_mut();
                    c.1 = true;
                    std::mem::take(&mut c.2)
                };
                for load in waiting {
                    load();
                }
            });
            match cookie {
                Some(cookie) => unsafe {
                    let jar: Retained<AnyObject> = msg_send![&*self.0.data, httpCookieStore];
                    let _: () = msg_send![&*jar, setCookie: &*cookie, completionHandler: &*done];
                },
                None => done.call(()),
            }
        }
    }

    pub struct HeightIvars {
        on_height: Box<dyn Fn(f64)>,
    }

    define_class!(
        // A page's script reports its height here (`webkit.messageHandlers.kyHeight`).
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "KyPageHeight"]
        #[ivars = HeightIvars]
        struct Height;

        impl Height {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn did_receive(&self, _controller: &AnyObject, message: &AnyObject) {
                let body: Option<Retained<AnyObject>> = unsafe { msg_send![message, body] };
                let Some(body) = body else { return };
                let number: bool = unsafe { msg_send![&*body, isKindOfClass: class("NSNumber")] };
                if number {
                    let h: f64 = unsafe { msg_send![&*body, doubleValue] };
                    (self.ivars().on_height)(h);
                }
            }
        }
    );

    impl Height {
        fn new(mtm: MainThreadMarker, on_height: Box<dyn Fn(f64)>) -> Retained<Height> {
            let this = Self::alloc(mtm).set_ivars(HeightIvars { on_height });
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Hands the embed's own height report (a `message` to itself, since it has no parent here) to
    /// the app.
    const REPORT: &str = "addEventListener('message', (e) => { if (e.data && typeof e.data.kySiteHeight === 'number') webkit.messageHandlers.kyHeight.postMessage(e.data.kySiteHeight); });";

    /// A native view: a transcript's clip, or a page's web view.
    #[derive(Clone)]
    // The height handler lives as long as its page.
    #[allow(dead_code)]
    pub struct View(Retained<AnyObject>, Option<Retained<Height>>);

    impl View {
        /// A clipping view over the window's content.
        pub fn clip() -> Option<View> {
            let parent = content_view()?;
            unsafe {
                let a: Allocated<AnyObject> = msg_send![class("NSView"), alloc];
                let view: Retained<AnyObject> = msg_send![a, initWithFrame: Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }];
                let _: () = msg_send![&*view, setWantsLayer: true];
                let layer: Option<Retained<AnyObject>> = msg_send![&*view, layer];
                if let Some(layer) = layer {
                    let _: () = msg_send![&*layer, setMasksToBounds: true];
                }
                let _: () = msg_send![&*view, setHidden: true];
                let _: () = msg_send![&*parent, addSubview: &*view];
                Some(View(view, None))
            }
        }

        /// A web view in `clip` showing `source`.
        pub fn page(clip: &View, store: &Store, source: &super::Source, dark: bool, on_height: Box<dyn Fn(f64)>) -> Option<View> {
            let mtm = MainThreadMarker::new()?;
            unsafe {
                let config: Retained<AnyObject> = msg_send![class("WKWebViewConfiguration"), new];
                let _: () = msg_send![&*config, setWebsiteDataStore: &*store.0.data];
                let content: Retained<AnyObject> = msg_send![&*config, userContentController];
                let height = Height::new(mtm, on_height);
                let _: () = msg_send![&*content, addScriptMessageHandler: &*height, name: &*string("kyHeight")];
                let a: Allocated<AnyObject> = msg_send![class("WKUserScript"), alloc];
                // WKUserScriptInjectionTimeAtDocumentStart, main frame only.
                let script: Retained<AnyObject> = msg_send![a, initWithSource: &*string(REPORT), injectionTime: 0isize, forMainFrameOnly: true];
                let _: () = msg_send![&*content, addUserScript: &*script];

                let a: Allocated<AnyObject> = msg_send![class("WKWebView"), alloc];
                let web: Retained<AnyObject> = msg_send![a, initWithFrame: Rect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 }, configuration: &*config];
                let no: Retained<AnyObject> = msg_send![class("NSNumber"), numberWithBool: false];
                let _: () = msg_send![&*web, setValue: &*no, forKey: &*string("drawsBackground")];
                let _: () = msg_send![&*web, setWantsLayer: true];
                let layer: Option<Retained<AnyObject>> = msg_send![&*web, layer];
                if let Some(layer) = layer {
                    let _: () = msg_send![&*layer, setCornerRadius: 12.0f64];
                    let _: () = msg_send![&*layer, setMasksToBounds: true];
                }
                let _: () = msg_send![&*clip.0, addSubview: &*web];

                let url = format!("{}{}embed={}", source.url, if source.url.contains('?') { "&" } else { "?" }, if dark { "dark" } else { "light" });
                let web2 = web.clone();
                let load = Box::new(move || {
                    let url: Option<Retained<AnyObject>> = msg_send![class("NSURL"), URLWithString: &*string(&url)];
                    let Some(url) = url else { return };
                    let request: Retained<AnyObject> = msg_send![class("NSURLRequest"), requestWithURL: &*url];
                    let _: Option<Retained<AnyObject>> = msg_send![&*web2, loadRequest: &*request];
                });
                store.signed_in(&source.base, source.token.as_deref(), load);
                Some(View(web, Some(height)))
            }
        }

        /// Off the window, its subviews with it.
        pub fn remove(&self) {
            unsafe {
                let _: () = msg_send![&*self.0, removeFromSuperview];
            }
        }

        pub fn set_hidden(&self, hidden: bool) {
            unsafe {
                let was: bool = msg_send![&*self.0, isHidden];
                if was != hidden {
                    let _: () = msg_send![&*self.0, setHidden: hidden];
                }
            }
        }

        /// `rect` in window points (y down) to the frame in the content view's own space.
        pub fn place_in_window(&self, [x, y, w, h]: [f32; 4]) {
            unsafe {
                let parent: Option<Retained<AnyObject>> = msg_send![&*self.0, superview];
                let Some(parent) = parent else { return };
                let flipped: bool = msg_send![&*parent, isFlipped];
                let bounds: Rect = msg_send![&*parent, bounds];
                let y = if flipped { y as f64 } else { bounds.h - (y + h) as f64 };
                set_frame(&self.0, Rect { x: x as f64, y, w: w as f64, h: h as f64 });
            }
        }

        /// Where the view shows, in window points (y down), or `None` while it or its clip hides.
        pub fn in_window(&self) -> Option<[f32; 4]> {
            unsafe {
                let hidden: bool = msg_send![&*self.0, isHiddenOrHasHiddenAncestor];
                if hidden {
                    return None;
                }
                let frame: Rect = msg_send![&*self.0, frame];
                let parent: Option<Retained<AnyObject>> = msg_send![&*self.0, superview];
                let none: *const AnyObject = std::ptr::null();
                let r: Rect = msg_send![&*parent?, convertRect: frame, toView: none];
                let h: Rect = msg_send![&*content_view()?, bounds];
                Some([r.x as f32, (h.h - r.y - r.h) as f32, r.w as f32, r.h as f32])
            }
        }

        /// `rect` from the clip's top-left (y down) to the frame in a clip `clip_h` tall.
        pub fn place_in_clip(&self, [x, y, w, h]: [f32; 4], clip_h: f32) {
            set_frame(&self.0, Rect { x: x as f64, y: (clip_h - y - h) as f64, w: w as f64, h: h as f64 });
        }
    }

    fn set_frame(view: &AnyObject, to: Rect) {
        unsafe {
            let now: Rect = msg_send![view, frame];
            if (now.x - to.x).abs() < 0.25 && (now.y - to.y).abs() < 0.25 && (now.w - to.w).abs() < 0.25 && (now.h - to.h).abs() < 0.25 {
                return;
            }
            let _: () = msg_send![view, setFrame: to];
        }
    }
}
