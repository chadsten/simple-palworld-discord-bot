/**
 * Post-build step: stamp the packaged exe with the app icon.
 *
 * The prior `rcedit` approach shelled out to a native helper that hangs forever
 * on the ~100 MB SEA binary @yao-pkg/pkg produces. This rewrites the PE resource
 * table entirely in JavaScript via `resedit` (no native subprocess), which handles
 * the large SEA binary in well under a second.
 *
 * On Windows, @yao-pkg/pkg (via postject) embeds the single-executable payload as a
 * PE resource of type RT_RCDATA (10) named `NODE_SEA_BLOB`; Node locates that
 * resource at startup to run the embedded app. If the icon stamp dropped or
 * corrupted it, the exe would fall back to a bare Node REPL instead of launching
 * the bot — a broken binary that is worse than a missing icon. resedit reads every
 * resource entry into memory and writes them all back, so replacing only the icon
 * group (RT_GROUP_ICON id 1, lang 1033) leaves `NODE_SEA_BLOB` byte-identical. To
 * guarantee that invariant across future pkg/resedit changes, the generated binary
 * is re-parsed in-memory and the blob's presence and exact size are asserted BEFORE
 * the exe on disk is overwritten — so a regression fails the build loudly and never
 * ships a broken exe. It also folds a VersionInfo resource (RT_VERSION, distinct from
 * the RCDATA blob) into the same resource pass so Task Manager and the file properties
 * show the app name rather than "Node.js". Invoked from the `build` script after pkg
 * produces dist/exos-palworld-bot.exe. Exits non-zero on failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit';

const exePath = fileURLToPath(new URL('../dist/exos-palworld-bot.exe', import.meta.url));
const iconPath = fileURLToPath(new URL('../assets/app.ico', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** PE resource type RT_RCDATA — the type postject uses for the SEA payload. */
const RT_RCDATA = 10;
/** Resource id postject assigns to the single-executable payload on Windows. */
const SEA_BLOB_ID = 'NODE_SEA_BLOB';

/** Locate the NODE_SEA_BLOB resource entry, or null when the exe carries no SEA payload. */
const findSeaBlob = (entries) =>
  entries.find((e) => e.type === RT_RCDATA && e.id === SEA_BLOB_ID) ?? null;

try {
  const exe = NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const iconFile = Data.IconFile.from(readFileSync(iconPath));

  // Snapshot the SEA payload before stamping so the post-stamp guard can prove it survived.
  const originalBlob = findSeaBlob(res.entries);
  if (!originalBlob) {
    throw new Error(`${SEA_BLOB_ID} resource not found; refusing to stamp a non-SEA binary`);
  }
  const expectedBlobSize = originalBlob.bin.byteLength;

  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    1033,
    iconFile.icons.map((icon) => icon.data)
  );

  // Stamp a VersionInfo resource so Task Manager, the taskbar, and file properties
  // report the app name (FileDescription) instead of the generic "Node.js". Version
  // numbers come from package.json; setFileVersion/setProductVersion write both the
  // numeric VS_FIXEDFILEINFO and the matching string values (1033 = en-US).
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  const vi = Resource.VersionInfo.createEmpty();
  vi.setFileVersion(major, minor, patch, 0, 1033);
  vi.setProductVersion(major, minor, patch, 0, 1033);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      ProductName: "Exo's Palworld Bot",
      FileDescription: "Exo's Palworld Bot",
      CompanyName: 'Exo',
      OriginalFilename: 'exos-palworld-bot.exe',
      InternalName: 'exos-palworld-bot',
      LegalCopyright: 'Copyright 2026'
    }
  );
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);

  // Flip CONSOLE (3) -> GUI (2) so the packaged exe launches with no console window.
  // node22-win-x64 is always PE32+; subsystem lives in the optional header. The
  // existing NODE_SEA_BLOB guard below still covers this write (it's a 2-byte header
  // change, no resource sections touched), and generate() recomputes the checksum.
  const prevSubsystem = exe.newHeader.optionalHeader.subsystem;
  exe.newHeader.optionalHeader.subsystem = 2; // IMAGE_SUBSYSTEM_WINDOWS_GUI
  console.log(`Subsystem ${prevSubsystem} -> 2 (GUI, windowless)`);

  const stamped = Buffer.from(exe.generate());

  // Re-parse the freshly generated binary and confirm the SEA payload is intact
  // before touching the exe on disk. If resedit ever drops or truncates the blob,
  // this throws and the original exe is left untouched.
  const verifyRes = NtExecutableResource.from(NtExecutable.from(stamped, { ignoreCert: true }));
  const verifyBlob = findSeaBlob(verifyRes.entries);
  if (!verifyBlob) {
    throw new Error(`${SEA_BLOB_ID} resource was lost during icon stamp — exe not written`);
  }
  if (verifyBlob.bin.byteLength !== expectedBlobSize) {
    throw new Error(
      `${SEA_BLOB_ID} resource size changed (${expectedBlobSize} -> ${verifyBlob.bin.byteLength}) ` +
        'during icon stamp — exe not written'
    );
  }

  writeFileSync(exePath, stamped);
  console.log(`Stamped icon onto ${exePath} (${SEA_BLOB_ID} intact, ${expectedBlobSize} bytes)`);
} catch (error) {
  console.error(`Failed to stamp exe icon: ${error.message}`);
  process.exit(1);
}
