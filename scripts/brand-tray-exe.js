/**
 * Pre-build step: brand the bundled `trayicon` helper exe.
 *
 * The `trayicon` package ships a tiny C# helper at rsrcs/trayicon.exe whose
 * VersionInfo FileDescription is "TrayIcon". At runtime the library copies that
 * helper to a temp dir and spawns it, and Windows Task Manager lists a process by
 * its FileDescription — so the tray helper shows up as "TrayIcon (32 bit)" rather
 * than anything tied to this app. This rewrites only the helper's VersionInfo (via
 * `resedit`, the same in-JS PE editor set-exe-icon.js uses) so the process reads as
 * "Exo's Palworld Bot Tray" instead. It runs BEFORE pkg bundles rsrcs/**, so the
 * branded helper is what gets embedded in the packaged exe; because CI runs `npm ci`
 * (which restores the vanilla helper) immediately before `npm run build`, this must
 * live in the build script rather than run once. outputToResourceEntries REPLACES any
 * existing VS_VERSION_INFO, so re-running every build is idempotent — it just restamps
 * the same values. Unlike the main exe this helper is a 32-bit PE with no NODE_SEA_BLOB,
 * so only VersionInfo is touched; the subsystem, icon, and headers are left untouched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';

const exePath = fileURLToPath(new URL('../node_modules/trayicon/rsrcs/trayicon.exe', import.meta.url));
const pkgPath = new URL('../node_modules/trayicon/package.json', import.meta.url);

// The helper is optional (e.g. a context where trayicon isn't installed); a missing
// file is not a build failure — just skip and let pkg's asset glob handle the rest.
if (!existsSync(exePath)) {
  console.warn(`trayicon helper not found at ${exePath}; skipping branding`);
  process.exit(0);
}

try {
  // Version numbers track the trayicon package so the helper's file/product version
  // stays truthful; fall back to the pinned 1.2.2 if the manifest can't be read.
  const [major = 1, minor = 2, patch = 2] = (() => {
    try {
      return JSON.parse(readFileSync(pkgPath, 'utf8')).version.split('.').map(Number);
    } catch {
      return [1, 2, 2];
    }
  })();

  const exe = NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const vi = Resource.VersionInfo.createEmpty();
  vi.setFileVersion(major, minor, patch, 0, 1033);
  vi.setProductVersion(major, minor, patch, 0, 1033);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      ProductName: "Exo's Palworld Bot Tray",
      FileDescription: "Exo's Palworld Bot Tray",
      CompanyName: 'Exo',
      OriginalFilename: 'trayicon.exe',
      InternalName: 'trayicon'
    }
  );
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));

  console.log('Branded trayicon helper: FileDescription -> "Exo\'s Palworld Bot Tray"');
} catch (error) {
  console.error(`Failed to brand trayicon helper: ${error.message}`);
  process.exit(1);
}
