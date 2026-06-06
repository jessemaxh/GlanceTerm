# GlanceTerm — Vendored Tabby Changes Inventory

GlanceTerm carries the Tabby source as top-level sibling directories
(`tabby-core/`, `tabby-local/`, `tabby-terminal/`, etc.) rather than as
node_modules. Several files have been modified or net-new to support the
AI-sidebar plugin's extension points. This is the canonical list, so the
next contributor (or the next upstream-Tabby rebase) knows exactly what
GlanceTerm-specific code is mixed in.

> **Heuristic for adding a new entry to this file**: if you touch anything
> under `tabby-*/`, add a row. `git log --diff-filter=AM -- tabby-core/
> tabby-local/ tabby-terminal/` should match the entries here at any
> given commit. If they drift, this file is stale.

> **Why not generate `.patch` files via `patch-package`**: patch-package
> targets `node_modules`. The vendored-Tabby tree lives in the repo
> proper and is version-controlled directly, so the diffs are already
> reproducible from `git diff`. A separate `.patch` file in
> `glanceterm-patches/` would just duplicate git history and rot. If we
> ever drop in a fresh upstream Tabby snapshot, the right tool is
> `git format-patch <upstream-tag>..HEAD -- tabby-core/ tabby-local/
> tabby-terminal/`.

---

## tabby-core

### `src/api/sidebarProvider.ts` — NEW FILE

Defines the `SidebarProvider` extension point that the AI-sidebar plugin
contributes to. Exports `SidebarContribution` (id, title, component,
side, default width / visibility) so a plugin can declare a sidebar
without touching `appRoot.component`.

**Why**: Upstream Tabby has no concept of plugin-contributed left/right
sidebars. The AI-sidebar plugin needs a contribution point to render its
`AiSidebarComponent` inside `appRoot` without modifying it per plugin.

**Rebase risk**: low. Pure new file, no upstream conflict surface.

### `src/services/sidebar.service.ts` — NEW FILE

Runtime state for `SidebarProvider`: which contributions are currently
visible, persisted widths, a `toggle(id)` API used by the plugin's
toolbar button.

**Why**: Companion to `sidebarProvider.ts`. Subscribed from
`appRoot.component`.

**Rebase risk**: low. Pure new file.

### `src/components/appRoot.component.{ts,pug,scss}` — MODIFIED

Renders the `.sidebar-slot` containers for every registered
`SidebarContribution`, and wires drag-resize for them.

**Why**: The injection point for `SidebarContribution.component`.
Without this, sidebar contributions have no DOM to mount into.

**Rebase risk**: MEDIUM. `appRoot.component` is high-traffic in
upstream Tabby. A non-trivial upstream change to its template will
require manually re-applying the slot rendering.

**What to look for** if upstream changes appRoot:
- `import { SidebarProvider, SidebarContribution } from '../api/sidebarProvider'`
- `import { SidebarService } from '../services/sidebar.service'`
- `sidebars: SidebarContribution[]`, `sidebarRevision: number`,
  `sidebarService: SidebarService` injected via the constructor's
  `@Optional() @Inject(SidebarProvider) sidebarProviders` collection.
- `.sidebar-slot` markup in `appRoot.component.pug`.
- Width / resize / open-close handlers in `.ts` and `.scss`.

### `src/api/commands.ts` — MODIFIED (lines ~35–60, `Command.fromToolbarButton`)

`Command.fromToolbarButton` now defines `icon` as a forwarding
`Object.defineProperty` getter against the source `ToolbarButton`,
instead of taking a one-time snapshot.

**Why**: The AI-sidebar plugin's toolbar button uses `get icon()` to
inline a live unread-count badge into its SVG. Without forwarding, the
toolbar snapshot freezes the boot-time icon and the badge never
updates.

**Rebase risk**: MEDIUM. Tiny diff but easy to miss in a manual rebase.
14 lines added inside `fromToolbarButton`. If upstream rewrites
`Command`, port via `Object.defineProperty` on the constructed Command
rather than reassigning `command.icon = button.icon`.

### `src/api/index.ts` — MODIFIED (2 re-exports)

Two re-exports added so the AI-sidebar plugin can import the sidebar
contribution types from `'tabby-core'` directly:

- line 7:  `export { SidebarProvider, SidebarContribution, SidebarSide } from './sidebarProvider'`
- line 37: `export { SidebarService } from '../services/sidebar.service'`

**Why**: Companion to the new sidebarProvider + sidebar.service files
above; without these re-exports the plugin would have to deep-import
across the module boundary.

**Rebase risk**: trivial — two surgical add-only lines.

### `src/components/startPage.component.pug`, `titleBar.component.pug`, `welcomeTab.component.pug` — MODIFIED (branding strings)

Strings rebranded from "Tabby" → "GlanceTerm" / "HiveTerm" in the
visible UI surfaces — start page header, title bar, welcome tab copy.

**Why**: Product rename. Pure visual; no behavioral change.

**Rebase risk**: trivial-but-real. Every upstream change to these
strings will leave a `.pug` diff to manually re-apply. Search/replace
on "Tabby" → "GlanceTerm" inside the .pug body usually does the job.

---

## tabby-local

### `src/session.ts` — MODIFIED

Adds `glancetermTabId: string = randomUUID()` (line ~59) and injects it
into the spawned PTY's environment block as `GLANCETERM_TAB_ID=<uuid>`
(line ~90, inside the `env: { ... }` block of `start()`).

**Why**: Every Tabby-spawned shell now stamps its PTY env with a
stable UUID, inherited by every descendant including `claude`, `codex`,
etc. The hook handler reads it back to attribute fire events to the
right tab. Without this, the AI-sidebar plugin can't tell which tab
fired a hook.

**Rebase risk**: MEDIUM-LOW. Two surgical edits in `start()`. If
upstream rewrites the `env` block structure, port manually.

**What to look for** if upstream changes session.ts:
- `glancetermTabId` field declaration.
- `import { randomUUID } from 'crypto'` (likely top of file).
- `GLANCETERM_TAB_ID: this.glancetermTabId` inside `env: { ... }`
  in `start()`.

---

## tabby-terminal

### `src/api/imagePasteHook.ts` — NEW FILE

Defines the `IMAGE_PASTE_HOOK` InjectionToken and `ImagePasteHook`
interface. The AI-sidebar plugin's `ImagePasteHookService` provides
this token; `BaseTerminalTabComponent.paste()` consults it before the
default text-paste path to intercept clipboard-image pastes (which
become a temp-file path typed into the focused AI agent).

**Why**: Native clipboard-image paste support for AI agents, without
modifying `BaseTerminalTabComponent` per plugin.

**Rebase risk**: low. Pure new file, re-exported from `src/index.ts:98`.

### `src/api/baseTerminalTab.component.ts` — MODIFIED (4 sites)

The paste-hook integration:
- **line 14**: `import { IMAGE_PASTE_HOOK, ImagePasteHook } from './imagePasteHook'`
- **line ~141**: `protected imagePasteHook?: ImagePasteHook` field declaration.
- **line ~221**: `this.imagePasteHook = injector.get<any>(IMAGE_PASTE_HOOK, null, InjectFlags.Optional) as ImagePasteHook | undefined` — Optional-DI resolution.
- **line ~551**: `if (this.imagePasteHook && await this.imagePasteHook.tryHandle(this)) { return }` — call-site in `paste()` before the default text-paste path.

**Why**: One-line hook into a high-traffic component. The conditional
short-circuit is the entire integration surface.

**Rebase risk**: MEDIUM. `baseTerminalTab.component` is high-churn
upstream. Any rewrite of `paste()` or the constructor's injector
plumbing needs each of the four sites manually re-stitched. The
imports + field are obvious; the `paste()` integration is one line and
easy to miss.

### `src/index.ts` — MODIFIED (1 line)

`export { IMAGE_PASTE_HOOK, ImagePasteHook, ImagePasteTarget } from './api/imagePasteHook'`

**Why**: makes the hook's symbols importable from `'tabby-terminal'`
by the AI-sidebar plugin.

**Rebase risk**: trivial.

---

## Upstream-PR candidates

Both new extension points are clean enough that upstream Tabby could
accept them. Pushing either reduces the rebase cost on the next sync:

- **`SidebarProvider` + `SidebarService`** — general-purpose plugin-
  contributed sidebar registration. Useful beyond GlanceTerm.
- **`IMAGE_PASTE_HOOK`** — generic clipboard-paste hook in
  `BaseTerminalTabComponent`. Other plugins (paste-to-pastebin, etc.)
  would use this.

`Command.fromToolbarButton`'s icon-getter forwarding is also a
candidate, though smaller and more GlanceTerm-shaped.

`session.ts`'s `GLANCETERM_TAB_ID` env injection is GlanceTerm-specific
and won't go upstream.

---

## Sanity-check command

To audit drift between this file and reality:

```bash
git diff --stat <upstream-tag-or-fork-point> -- tabby-core/ tabby-local/ tabby-terminal/
```

Every file with non-zero diff should have a row here. If a file appears
in `git diff` but not in this doc, either add a row or revert the
unintentional change.
