# Example warm color system

An optional example palette for local artboards. Prefer the user's own brand tokens and preserve the source-specific terms recorded in the bundled NOTICE.md.

## Primary (the foundation — most surfaces are just these two)

| Name  | Hex       | Use |
|-------|-----------|-----|
| Ivory | `#FAF9F5` | Page/artboard background. Never pure #FFF for full-page backgrounds. |
| Slate | `#141413` | Text, dark surfaces. |

Content surfaces (cards, panels) sit as `#FFFFFF` on top of Ivory.
Tinted hover/selected surfaces: `rgba(115,114,108,0.1)`. Borders
derive from Slate at low opacity — `0.5px solid rgba(31,30,29,0.15)`
default, `rgba(31,30,29,0.3)` stronger — never colored borders for
structure.

## Example UI palette

| Token | Hex | |
|-------|-----|---|
| Primary accent (Clay) | `#D97757` | the single emphasis color on neutral surfaces |
| Background (Ivory) | `#FAF9F5` | |
| Text (Slate) | `#141413` | |
| Subtle accent (Oat) | `#E3DACC` | subtle fills, dividers |
| Main accent (Blue) | `#2A78D6` | primary accent for other actions |

## Secondary (prismatic — illustrations and compositions, not UI chrome)

Strong: Fig `#C46686` · Sky `#6A9BCC` · Olive `#788C5D` · Clay `#D97757`
Subtle: Coral `#EBCECE` · Heather `#CBCADB` · Cactus `#BCD1CA` · Oat `#E3DACC`

## Warm grayscale (21 steps, black → white)

`#000000` 1000 · `#141413` 950 (Slate) · `#1A1918` 900 · `#1F1E1D` 850 ·
`#262624` 800 · `#30302E` 750 · `#3D3D3A` 700 · `#4D4C48` 650 ·
`#5E5D59` 600 · `#73726C` 550 · `#87867F` 500 · `#9C9A92` 450 ·
`#B0AEA5` 400 · `#C2C0B6` 350 · `#D1CFC5` 300 · `#DEDCD1` 250 ·
`#E8E6DC` 200 · `#F0EEE6` 150 · `#F5F4ED` 100 · `#FAF9F5` 050 (Ivory) ·
`#FFFFFF` 000

These are WARM grays — never substitute cool/neutral gray ramps.

## Tertiary scales (marketing/slides/dataviz — NOT product UI)

Nine-step scales exist for orange, yellow, green, aqua, blue, violet,
magenta, and red; the anchor 500s: orange `#D97757`, yellow `#C9A82D`,
green `#558A42`, aqua `#2E9191`, blue `#6A9BCC`, violet `#6B4D9E`,
magenta `#A64D87`. Reach for these only for charts and illustration
accents; product-looking UI stays in the primary + grayscale system.
