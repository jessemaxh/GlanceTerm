// Sentry crash reporting — disabled for GlanceTerm.
//
// The upstream Tabby code initialised Sentry against project id 181876 on
// sentry.io with DSN `4717a0a7ee0b4429bd3a0f06c3d7eec3` — Eugeny's account.
// Crash reports include renderer-side stack traces with absolute file paths,
// loaded module names, env-influenced state, sometimes user-visible string
// fragments via xterm.js write buffers. A GlanceTerm user expecting their
// crashes to be private would instead be uploading them to the upstream
// project's dashboard, which we have no control over.
//
// To re-enable for GlanceTerm: register our own Sentry project, paste the
// new DSN here, and remove the early return below. Until then the file
// exists only so `app/lib/index.ts`'s side-effect import doesn't crash on
// a missing module.
//
// The crashpad handler (Electron's native crash collector) still runs at
// the OS level and writes minidumps to ~/Library/Application Support/
// glanceterm-app/Crashpad/ — those are stored locally and only sent
// anywhere if a Sentry init() runs and tells crashpad where to upload.
// Without init(), they sit on disk until cleaned by macOS.
export {}
