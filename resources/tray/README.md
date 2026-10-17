# Menu-bar mark

Original TT-and-microphone artwork, distributed under the project's MIT licence.
It replaces the stock microphone symbol so Terry is distinguishable from the
macOS microphone privacy indicator.

`terryTemplate.svg` is the editable source. The app loads the transparent black
PNG as a macOS template image, so the system supplies the appropriate foreground
colour. The `@2x` representation supports Retina displays.

To regenerate after editing the SVG, install `librsvg` and run from the repo root:

```sh
rsvg-convert -w 30 -h 18 resources/tray/terryTemplate.svg -o resources/tray/terryTemplate.png
rsvg-convert -w 60 -h 36 resources/tray/terryTemplate.svg -o resources/tray/terryTemplate@2x.png
```

Inspect at 30 × 18 points on both a light and dark background before packaging.
The generated PNGs are committed, so ordinary builds need no image tooling.
