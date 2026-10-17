# Dark-mode contrast, before and after

WCAG contrast of the dark theme's tokens (src/ui/scotty.css), measured by a throwaway script. Translucent tokens (lines, the focus ring: accent at 60%) are laid over the surface first. Targets: body text 7:1, secondary text 4.5:1, borders and focus rings 3:1.

## Before

| token | bg | sidebar | surface | raised | sunken | user-bubble | target |
|---|---:|---:|---:|---:|---:|---:|---:|
| ink | 16.13 | 15.46 | 14.71 | 13.59 | 16.60 | 12.93 | 7 |
| muted | 7.49 | 7.17 | 6.83 | 6.31 | 7.70 | 6.00 | 4.5 |
| quiet | 4.59 | 4.40 ✗ | 4.18 ✗ | 3.87 ✗ | 4.72 | 3.68 ✗ | 4.5 |
| working | 8.62 |  | 7.86 |  |  |  | 4.5 |
| danger | 6.57 |  | 5.99 |  |  |  | 4.5 |
| success | 8.90 |  | 8.12 |  |  |  | 4.5 |
| warning | 9.46 |  | 8.63 |  |  |  | 4.5 |
| line-strong | 1.34 ✗ |  | 1.39 ✗ |  | 1.31 ✗ |  | 3 |
| line-hover | 1.65 ✗ |  | 1.71 ✗ |  | 1.61 ✗ |  | 3 |
| focus-ring | 6.30 |  | 6.05 | 5.78 |  |  | 3 |

10 pair(s) under target

## After

| token | bg | sidebar | surface | raised | sunken | user-bubble | target |
|---|---:|---:|---:|---:|---:|---:|---:|
| ink | 15.13 | 14.09 | 13.36 | 11.66 | 14.36 | 11.34 | 7 |
| muted | 9.01 | 8.39 | 7.95 | 6.94 | 8.55 | 6.75 | 4.5 |
| quiet | 6.63 | 6.17 | 5.85 | 5.11 | 6.29 | 4.97 | 4.5 |
| working | 8.62 |  | 7.61 |  |  |  | 4.5 |
| danger | 6.57 |  | 5.80 |  |  |  | 4.5 |
| success | 8.90 |  | 7.86 |  |  |  | 4.5 |
| warning | 9.46 |  | 8.35 |  |  |  | 4.5 |
| line-strong | 3.32 |  | 3.32 |  | 3.34 |  | 3 |
| line-hover | 5.33 |  | 5.12 |  | 5.26 |  | 3 |
| focus-ring | 5.98 |  | 5.64 | 5.20 |  |  | 3 |

0 pair(s) under target

## Light mode

Every custom property on :root, computed in Chromium on the running stack in the light theme, before and after: identical (`diff` printed nothing).
