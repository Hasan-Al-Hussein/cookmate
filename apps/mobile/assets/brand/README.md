# CookMate brand assets

Two unchanged Newsreader static faces are retained from Production Type's official repository, commit `cfcb4f7af0e52c25e8df2a2431814c8e5fe2e155`, fetched 28 September 2026:

| File | Runtime alias | Role | SHA-256 |
| --- | --- | --- | --- |
| Newsreader16pt-Regular.ttf | CookMateNewsreader | Editorial headings and wordmark | 0636887c9f72f77ce188f0b31029be58e65adae5a47e6d2887ad5020c2c75036 |
| Newsreader16pt-Italic.ttf | CookMateNewsreaderItalic | Restrained wordmark/headline accent | 292646cbb948153511e308fa80def59959746d70114bd0936ba0a7f67a33181d |

Upstream: https://github.com/productiontype/Newsreader/tree/cfcb4f7af0e52c25e8df2a2431814c8e5fe2e155/fonts/static/ttf

The included `OFL-Newsreader.txt` carries the copyright notice and SIL Open Font License 1.1. Preserve it with distributions containing these files. The font bytes are unmodified; aliases are application loader keys, not altered font names. Combined font size is 253,156 bytes. This license does not establish rights in recipe photos or reference screenshots.

Foundation/Frontend own runtime loading via the selected Expo integration. No loader, configuration, dependency or OS font installation was added here. Keep platform serif fallback for headings and native system sans for all reading/controls; font load failure must not block recipes. Native loading and metrics remain to be tested.

No raster logo, generated art or icon package is included. A native editable CookMate wordmark is sufficient. One consistent outline icon set should follow the existing compatible dependency choice; record its actual version/license before T08 acceptance. Do not add decorative controls to justify icon assets.
