# CookMate selected app icon

## Current selection — 30 September 2026

`app-icon.png` now contains the user's supplied 1024-square burgundy chef-hat and sparkle artwork, copied unchanged from `C:/Users/hp/Downloads/CookMate_App_Icon.png`. Source and installed asset SHA-256 match: `be7fc1faa4a15746ef425392e93139b31829e6e9174c85cd4390e4c487c27c9c`. Expo icon/splash configuration uses this PNG. `src/components/BrandMark.tsx` is a simple hand-authored SVG adaptation for small in-app use; it is not represented as the original editable artwork.

The adjacent `app-icon.svg` and the historical record below belong to the previous C-and-spoon proposal, not the current supplied icon. The old PNG is retained in the product-upgrade baseline checkpoint. Native launcher/splash appearance remains unverified.

## Historical selection

`app-icon.png` is an opaque 1024 × 1024 RGB square: warm ivory editorial C and spoon on CookMate burgundy. `app-icon.svg` is its editable path source, with no external font/image reference and no baked corner mask.

Root/APP Brain selected the burgundy C-and-spoon artwork and owns its integration. The intended app configuration path is `./assets/brand/app-icon.png`. Studio did not edit `app.json` or runtime configuration. Native iPhone appearance remains unverified.

The complete mark was centered with a 43-pixel horizontal correction. Small-size proof covers 256, 120, 60, 48 and 32 pixels; at 32 pixels the C remains clear while the spoon is a small oval-and-stem detail. Final PNG SHA-256: `026c17eecdde68653a1a9592901d2566ebe6d11e965ecdb8f006175a9d2be9e2`. Final SVG SHA-256: `b0cf533a6aa2f3d47ae089909a5d1c9a95530286b87741360760395f4e1293fd`.

The C outline uses the existing unmodified Newsreader 16pt Regular font from Production Type, pinned to commit `cfcb4f7af0e52c25e8df2a2431814c8e5fe2e155`. The bundled font's copyright/SIL OFL 1.1 notice is retained in the adjacent `OFL-Newsreader.txt`; the SVG contains graphic outlines rather than font software. Spoon geometry is authored for this CookMate task. No recipe photograph or external icon was used.

Full brief, source script, alternative comparisons, metadata and independent visual review: canonical CookMate folder → `implementation/studio/app-icon/`. No trademark clearance or unique ownership of the C/spoon motif is asserted.
