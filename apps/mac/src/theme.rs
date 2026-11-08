//! The web app's look, as Rune values. Every colour, size and radius here is a token from
//! `src/chat-kit/chat.css` (and the thread rules in `src/ui/shell.css`); change them there first,
//! then here, so the Mac app and the web app stay one design.

use rune::Color;
use rune::TextStyle;
use rune_kit::MarkdownStyle;

/// `--thread-width: 44rem`.
pub const THREAD_WIDTH: f32 = 704.0;
/// `--radius`.
pub const RADIUS: f32 = 10.0;
/// The system font, as the web's `-apple-system` resolves on a Mac.
pub const SANS: &str = "System Font";

pub const BODY: TextStyle = TextStyle::new(15.0, 400.0).lh(24.0);
pub const META: TextStyle = TextStyle::new(13.0, 400.0).lh(18.0);
pub const META_STRONG: TextStyle = TextStyle::new(13.0, 500.0).lh(18.0);
pub const TITLE: TextStyle = TextStyle::new(14.0, 600.0).lh(20.0);
/// `.chat-title`, `.chat-time` and `.sidebar-head`.
pub const ROW: TextStyle = TextStyle::new(13.5, 400.0).lh(18.0);
pub const ROW_STRONG: TextStyle = TextStyle::new(13.5, 500.0).lh(18.0);
pub const SMALL: TextStyle = TextStyle::new(11.5, 400.0).lh(14.0);
pub const HEAD: TextStyle = TextStyle::new(12.0, 500.0).lh(16.0);
/// `--sidebar-width`.
pub const SIDEBAR_WIDTH: f32 = 272.0;
/// The window's top band: the tab strip, and the sidebar's head beside the traffic lights.
pub const BAR: f32 = 44.0;

#[derive(Clone, Copy)]
pub struct Palette {
    pub bg: Color,
    pub surface: Color,
    pub raised: Color,
    pub sunken: Color,
    /// `--sidebar`: the chat list's ground.
    pub sidebar: Color,
    pub hover: Color,
    /// A selected row or the active tab: `--hover`, a step stronger.
    pub selected: Color,
    pub ink: Color,
    pub muted: Color,
    pub quiet: Color,
    pub line: Color,
    pub line_strong: Color,
    pub working: Color,
    pub danger: Color,
    pub success: Color,
    pub warning: Color,
    /// `--chart-1` … `--chart-6`: a card's series, in order.
    pub chart: [Color; 6],
    pub shadow: Color,
    /// Under a sheet or the palette: `--overlay` at 55%.
    pub scrim: Color,
    /// The user's words: solid ink, the one bold thing in the chat that is not ky's.
    pub user_bubble: Color,
    pub user_ink: Color,
    /// Appearance › Accent: the user's bubble and the words on it. Ink unless an accent is chosen.
    pub accent: Color,
    pub accent_ink: Color,
}

fn hex(s: &str) -> Color {
    rune::color::hex(s).expect("a token colour")
}

fn ink_alpha(dark: bool, a: f32) -> Color {
    if dark { Color { r: 1.0, g: 1.0, b: 1.0, a } } else { Color { r: 0.0, g: 0.0, b: 0.0, a } }
}

pub fn palette(dark: bool) -> Palette {
    if dark {
        // `:root[data-mode="dark"]`, the contrast-checked dark theme.
        Palette {
            bg: hex("#111111"),
            surface: hex("#1e1e1e"),
            raised: hex("#292929"),
            sunken: hex("#171717"),
            sidebar: hex("#191919"),
            hover: ink_alpha(true, 0.06),
            selected: ink_alpha(true, 0.09),
            ink: hex("#e6e6e6"),
            muted: hex("#b3b3b3"),
            quiet: hex("#999999"),
            line: ink_alpha(true, 0.1),
            line_strong: ink_alpha(true, 0.36),
            working: hex("#6cb6f0"),
            danger: hex("#f07266"),
            success: hex("#62c58e"),
            warning: hex("#e0b057"),
            chart: [hex("#6cb6f0"), hex("#e0b057"), hex("#62c58e"), hex("#b39af0"), hex("#f07a66"), hex("#9aa5b1")],
            shadow: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.35 },
            scrim: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.5 },
            user_bubble: hex("#e6e6e6"),
            user_ink: hex("#141414"),
            accent: hex("#e6e6e6"),
            accent_ink: hex("#141414"),
        }
    } else {
        Palette {
            bg: hex("#ffffff"),
            surface: hex("#ffffff"),
            raised: hex("#f3f3f3"),
            sunken: hex("#f7f7f7"),
            sidebar: hex("#f7f7f7"),
            hover: ink_alpha(false, 0.045),
            selected: ink_alpha(false, 0.07),
            ink: hex("#141414"),
            muted: hex("#666666"),
            quiet: hex("#8a8a8a"),
            line: ink_alpha(false, 0.075),
            line_strong: ink_alpha(false, 0.12),
            working: hex("#2f8fdc"),
            danger: hex("#cf3b2e"),
            success: hex("#2f9b62"),
            warning: hex("#b07a12"),
            chart: [hex("#2f8fdc"), hex("#c98a14"), hex("#2f9b62"), hex("#8a5cd6"), hex("#d4553f"), hex("#6b7785")],
            shadow: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.06 },
            scrim: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.22 },
            user_bubble: hex("#141414"),
            user_ink: hex("#ffffff"),
            accent: hex("#141414"),
            accent_ink: hex("#ffffff"),
        }
    }
}

/// ky's Markdown (`src/ui/chat-content.css`): ink text, sunken code, hairline rules.
pub fn markdown(dark: bool) -> MarkdownStyle {
    let p = palette(dark);
    MarkdownStyle::neutral(dark)
        .text(p.ink)
        .muted(p.muted)
        .link(p.ink)
        .link_underline(p.line_strong)
        .inline_code_bg(p.raised)
        .code_block(p.sunken, p.line)
        .code_block_padding(16.0, 12.0)
        .rule(p.line)
        .quote_rule(p.line_strong)
        .body_font(BODY)
        .strong_weight(600.0)
        .list(22.0, 6.0)
}

/// rune-kit's controls (the tab strip) in the web's tokens: the strip on the page's ground, the
/// active tab a step of ink over it, as the web's selected sidebar row.
pub fn kit(dark: bool) -> rune_kit::Kit {
    let p = palette(dark);
    let mut k = rune_kit::Kit::neutral(dark);
    let c = &mut k.c;
    c.bg_deep = p.bg;
    c.hover = p.hover;
    c.pressed = p.selected;
    c.text_base = p.ink;
    c.text_muted = p.muted;
    c.text_faint = p.quiet;
    c.icon_base = p.muted;
    c.icon_muted = p.quiet;
    c.border_muted = p.line;
    c.border_strong = p.line_strong;
    c.bg_accent = p.working;
    k.ty.ui_compact = META;
    k
}

/// Settings › Appearance › Accent (`chat.css`): the name, light hex, dark hex. Ink is the page's
/// own ink. The user's bubble takes the accent, with white words.
pub const ACCENTS: &[(&str, &str, &str)] = &[
    ("Ink", "", ""),
    ("Violet", "#5b2fc9", "#7650e0"),
    ("Blue", "#1f62d1", "#3a7ce0"),
    ("Green", "#12784f", "#1f8d60"),
    ("Ember", "#c2410c", "#d4561c"),
    ("Pink", "#be2f6b", "#cf467f"),
];

/// The palette with `accent` (an index into `ACCENTS`) on the user's bubble.
pub fn accented(mut p: Palette, accent: usize, dark: bool) -> Palette {
    if let Some((_, light, dark_hex)) = ACCENTS.get(accent).filter(|_| accent > 0) {
        p.accent = hex(if dark { dark_hex } else { light });
        p.accent_ink = Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };
    }
    p
}

/// The web's icons (`src/chat-kit/Icon.tsx`): 16-point strokes, 1.5 wide, round ends.
pub mod icons {
    use rune::Icon;

    macro_rules! stroke {
        ($name:ident, $id:literal, $d:literal) => {
            pub static $name: Icon = Icon {
                name: $id,
                view: 16.0,
                body: concat!(r#"<path d=""#, $d, r#"" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#),
            };
        };
    }

    stroke!(PULSE, "ky-pulse", "M1.75 8h2.5l1.75-4.25 3.5 8.5 1.75-4.25h2.995");
    stroke!(STOP, "ky-stop", "M4.5 4.5h7v7h-7z");
    stroke!(PAUSE, "ky-pause", "M4.75 4h2v8h-2zM9.25 4h2v8h-2z");
    stroke!(PIN, "ky-pin", "M5.75 2.75h4.5M6.75 2.75v3.5L4.75 9h6.5l-2-2.75v-3.5M8 9v4.25");
    stroke!(THOUGHT, "ky-thought", "M3.25 7.5a4.75 4 0 1 1 2.5 3.5l-2.5 1.25.75-2.25A3.9 3.9 0 0 1 3.25 7.5Z");
    stroke!(COMPRESS, "ky-compress", "M5.25 2.75v2.5h-2.5M10.75 2.75v2.5h2.5M5.25 13.25v-2.5h-2.5M10.75 13.25v-2.5h2.5");
    stroke!(FINGERPRINT, "ky-fingerprint", "M4.25 4.5A4.75 4.75 0 0 1 12.6 6.5M3.25 8a4.75 4.75 0 0 1 .3-1.6M5.5 13a7 7 0 0 0 .75-3.25 1.75 1.75 0 0 1 3.5 0c0 1.25-.2 2.4-.6 3.5M8 9.75c0 1.6-.35 3-1 4.25M11.5 12.25c.3-.8.5-1.6.5-2.5a4 4 0 0 0-6.6-3");
    stroke!(HEART, "ky-heart", "M8 13.25S2.25 10 2.25 6.1A2.85 2.85 0 0 1 8 4.6a2.85 2.85 0 0 1 5.75 1.5C13.75 10 8 13.25 8 13.25Z");
    stroke!(MORE, "ky-more", "M3.75 8h.01M8 8h.01M12.25 8h.01");
    stroke!(PLUS, "ky-plus", "M8 3.25v9.5M3.25 8h9.5");
    stroke!(PAPERCLIP, "ky-paperclip", "M10.5 5.5 6.2 9.8a1.25 1.25 0 0 0 1.77 1.77l4.6-4.6a2.75 2.75 0 0 0-3.9-3.9L4.1 7.7a4.25 4.25 0 0 0 6 6l3.4-3.4");
    stroke!(COMPOSE, "ky-compose", "M7.25 2.75h-4.5v10.5h10.5v-4.5M11.5 2.25l2.25 2.25-5.5 5.5H6v-2.25z");
    stroke!(SIDEBAR, "ky-sidebar", "M2.75 3.25h10.5v9.5H2.75zM6.25 3.25v9.5");
    stroke!(CHEVRON_RIGHT, "ky-chevron-right", "M6.5 4.25 10.25 8 6.5 11.75");
    stroke!(CHEVRON_DOWN, "ky-chevron-down", "M4.25 6.5 8 10.25l3.75-3.75");
    stroke!(CHEVRON_UP, "ky-chevron-up", "M4.25 9.5 8 5.75l3.75 3.75");
    stroke!(CLOSE, "ky-x", "M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5");
    stroke!(ARCHIVE, "ky-archive", "M2.75 3.25h10.5v2.5H2.75zM3.75 5.75v7h8.5v-7M6.5 8.25h3");
    stroke!(UNARCHIVE, "ky-unarchive", "M2.75 3.25h10.5v2.5H2.75zM3.75 5.75v7h8.5v-7M8 11.25v-3.5M6.25 9.5 8 7.75l1.75 1.75");
    stroke!(GEAR, "ky-gear", "M6.86 3.24L7.17 1.81L8.83 1.81L9.14 3.24L10.56 3.82L11.79 3.03L12.97 4.21L12.18 5.44L12.76 6.86L14.19 7.17L14.19 8.83L12.76 9.14L12.18 10.56L12.97 11.79L11.79 12.97L10.56 12.18L9.14 12.76L8.83 14.19L7.17 14.19L6.86 12.76L5.44 12.18L4.21 12.97L3.03 11.79L3.82 10.56L3.24 9.14L1.81 8.83L1.81 7.17L3.24 6.86L3.82 5.44L3.03 4.21L4.21 3.03L5.44 3.82ZM8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2Z");
    stroke!(CHAT, "ky-chat", "M2.75 3.25h10.5v7.5H7.5l-3 2.25v-2.25H2.75z");
    stroke!(COPY, "ky-copy", "M5.75 5.75h7.5v7.5h-7.5zM10.25 5.75v-3h-7.5v7.5h3");
    stroke!(CHECK, "ky-check", "M3.5 8.5l3 3 6-7");
    stroke!(MAIL, "ky-mail", "M2.75 3.75h10.5v8.5H2.75zM2.75 4.25 8 8.5l5.25-4.25");
    stroke!(CLOCK, "ky-clock", "M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5zM8 4.75V8l2.25 1.5");
    stroke!(BRANCH, "ky-branch", "M4.75 2.75v10.5M4.75 10.25c0-3 6.5-1.5 6.5-4.5M4.75 2.75a0 0 0 0 0 0 0M11.25 5.75a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.75 13.25a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z");
    stroke!(FILE, "ky-file", "M4 2.25h5l3 3v8.5H4zM9 2.25v3h3");
    stroke!(GLOBE, "ky-globe", "M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5zM2.25 8h11.5M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75M8 2.25C6.4 3.85 5.6 5.75 5.6 8s.8 4.15 2.4 5.75");
    stroke!(PLUG, "ky-plug", "M6 2.25v3M10 2.25v3M4.25 5.25h7.5v2.5a3.75 3.75 0 0 1-7.5 0zM8 11.5v2.25");
    stroke!(LIST, "ky-list", "M6 4.25h7.25M6 8h7.25M6 11.75h7.25M2.75 4.25h.5M2.75 8h.5M2.75 11.75h.5");
    stroke!(SPARKLE, "ky-sparkle", "M8 2.25c.4 2.9 1.85 4.35 4.75 4.75-2.9.4-4.35 1.85-4.75 4.75-.4-2.9-1.85-4.35-4.75-4.75 2.9-.4 4.35-1.85 4.75-4.75z");
    stroke!(REFRESH, "ky-refresh", "M12.75 8a4.75 4.75 0 1 1-1.4-3.36M12.75 2.75v2.5h-2.5");
    stroke!(ALERT, "ky-alert", "M8 2.5 14 13H2zM8 6.5v3M8 11.25v.01");
    stroke!(CHECK_CIRCLE, "ky-check-circle", "M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5zM5.5 8.25l1.75 1.75 3.25-3.75");
    stroke!(CIRCLE, "ky-circle", "M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5z");
    stroke!(EXTERNAL, "ky-external", "M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11.75 9.5v3.75h-9v-9h3.75");
    stroke!(PLAY, "ky-play", "M5 3.25v9.5L12.5 8z");
    stroke!(KEY, "ky-key", "M5.75 7.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5zM7.75 8.25l5.5-5.5M11.25 4.75l1.5 1.5");
    stroke!(SEARCH, "ky-search", "M7 2.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5zM10.25 10.25l3 3");
    stroke!(SUN, "ky-sun", "M8 5.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5zM8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1");
    stroke!(MOON, "ky-moon", "M13.25 9.5A5.5 5.5 0 0 1 6.5 2.75a5.5 5.5 0 1 0 6.75 6.75z");
    stroke!(PENCIL, "ky-pencil", "M10.75 2.75l2.5 2.5-7.5 7.5h-2.5v-2.5z");
    stroke!(MACHINE, "ky-machine", "M2.75 3.25h10.5v7.5H2.75zM5.75 13.25h4.5M8 10.75v2.5");
    stroke!(USER, "ky-user", "M8 2.75a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5zM3 13.25c.6-2.3 2.6-3.5 5-3.5s4.4 1.2 5 3.5");
    stroke!(BOOK, "ky-book", "M3 3.25h4.25A1.75 1.75 0 0 1 8 5v8.25a1.5 1.5 0 0 0-1.5-1.5H3zM13 3.25H8.75A1.75 1.75 0 0 0 8 5v8.25a1.5 1.5 0 0 1 1.5-1.5H13z");
    stroke!(BOLT, "ky-bolt", "M9 1.75 3.75 9h4.5L7 14.25 12.25 7h-4.5z");
    stroke!(WALLET, "ky-wallet", "M2.75 4.25h10.5v8.5H2.75zM10 8.5h3.25M2.75 6.25h10.5");
}
