/**
 * Pre-build step: regenerate assets/app.ico from assets/app-source.png.
 *
 * Windows renders the tray, taskbar, and file-explorer icons from whichever frame
 * best matches the target DPI, so a single 256x256 frame downscaled on the fly looks
 * muddy at small sizes. This resamples the source PNG to each frame size with sharp's
 * lanczos3 kernel (crisp per-size frames), then packs them into a multi-frame .ico via
 * png-to-ico. Runs before pkg so the fresh icon is bundled into the snapshot; sharp is a
 * build-time devDependency only and is never imported by the shipped app.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const src = fileURLToPath(new URL('../assets/app-source.png', import.meta.url));
const out = fileURLToPath(new URL('../assets/app.ico', import.meta.url));
const sizes = [16, 24, 32, 48, 256];

const buffers = await Promise.all(
  sizes.map((s) =>
    sharp(readFileSync(src))
      .resize(s, s, { kernel: 'lanczos3', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
  )
);

writeFileSync(out, await pngToIco(buffers));
console.log(`Wrote ${out} with sizes ${sizes.join(', ')}`);
