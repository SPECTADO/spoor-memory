# Research: web-stack (packages/web)

Date: 2026-10-19. Cutoff for versions: published on or before 2026-10-16 (3-day delay). Dates from `npm view <pkg> time --json`; peer/engine data from `npm view <pkg>@<ver> peerDependencies engines`.

## Pinned versions (all within cutoff)

| Package | Version | Released | Notes |
|---|---|---|---|
| react / react-dom | 19.3.1 | 2026-10-14 | 18.3.1 is last 18 (2024-04-26) |
| @types/react | 19.3.0 | 2026-09-09 | (+ @types/react-dom matching) |
| vite | 8.3.4 | 2026-10-08 | Rolldown-based; engines node ^20.19.0 or >=22.12.0 (Node 22 LTS OK) |
| @vitejs/plugin-react | 6.1.2 | 2026-10-05 | peer `vite ^8.0.0` only |
| tailwindcss | 4.3.3 | 2026-07-16 | |
| @tailwindcss/vite | 4.3.3 | 2026-07-16 | peer `vite ^5.2 or ^6 or ^7 or ^8` |
| @tanstack/react-query | 5.104.3 | 2026-10-15 | peer `react ^18 or ^19` |
| react-router | 7.18.4 | 2026-09-15 | last v7 (dist-tag `version-7`); engines node >=20, peer react >=18 |
| @uiw/react-codemirror | 4.25.12 | 2026-09-24 | |
| @codemirror/lang-markdown | 6.5.2 | 2026-08-04 | |
| @codemirror/language-data | 6.5.2 | 2025-10-23 | optional: highlight fenced code in editor |
| @codemirror/view | 6.43.14 | 2026-10-07 | peer of react-codemirror |
| react-markdown | 10.1.0 | 2025-03-07 | peer `@types/react >=18`, `react >=18` |
| remark-gfm | 4.0.1 | 2025-02-10 | |
| diff | 9.0.0 | 2026-04-13 | ships own types (`types: libcjs/index.d.ts`), ESM; no @types/diff needed |
| lucide-react | 1.58.0 | 2026-10-16 | 1.59.0 is newer than cutoff, avoid. peer react ^16.5 to ^19 |
| @playwright/test | 1.64.1 | 2026-10-14 | |
| typescript | 6.0.3 | 2026-04-16 | 7.0.2 exists (2026-07-08); not evaluated for this stack, prefer 6.x |
| unist-util-visit | 5.1.0 | 2026-01-22 | only if plugin uses it (see below; avoidable) |

Rejected: remark-wiki-link 2.0.1 (2023-10-10, deps micromark-extension-wiki-link ^0.0.4 and mdast-util-wiki-link ^0.1.2, i.e. ancient micromark 2 era, unmaintained). react-diff-viewer-continued 4.4.0 (2026-07-14; pulls @emotion/css, @emotion/react, classnames, js-yaml, memoize-one, refractor 5, diff ^9): 7 deps for one screen. react-router 8.x (8.4.0 on 2026-09-15; 8.5.0 is latest, after cutoff).

## Compatibility facts

- React 19 vs 18: every chosen lib accepts 19 (react-query ^18||^19, react-router >=18, react-markdown >=18, react-codemirror >=17, lucide ^19). Use 19.3.1. Caveat: react-router 8 would need react >=19.2.7 and node >=22.22.0 (`npm view react-router@8.3.1 peerDependencies engines`); v7 has no such floor.
- Vite 8 + plugin-react 6 + tailwind vite plugin 4.3.3: mutually compatible (peer ranges above). plugin-react 6 requires vite 8; do not mix with vite 7.
- Vite 8 deps: rolldown ~1.2.12, lightningcss, postcss (no esbuild by default; esbuild is an optional peer ^0.27/^0.28).
- Node 22 LTS fits all engines except react-router 8 (needs >=22.22.0).
- React Router 7 data mode: import `createBrowserRouter` from "react-router" and `RouterProvider` from "react-router/dom" (single package `react-router`; no `react-router-dom` needed). Source: https://reactrouter.com/start/data/installation (page served from 8.4.0 tag; the v7 API is the same shape).
```tsx
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
const router = createBrowserRouter([{ path: "/", element: <div>Hello World</div> }]);
ReactDOM.createRoot(root).render(<RouterProvider router={router} />);
```
  Create router once outside the React tree. Loaders can use `queryClient.ensureQueryData` (TanStack Query) if desired; keep it simple and use `useQuery` in components.
- Tailwind v4 via Vite (https://tailwindcss.com/docs/installation/using-vite): no tailwind.config.js, no postcss config.
```ts
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({ plugins: [react(), tailwindcss()] })
```
```css
@import "tailwindcss";
```

## CodeMirror 6 editor
`@uiw/react-codemirror` 4.25.12 lists as peers: react, react-dom, codemirror, @codemirror/view, @codemirror/state, @codemirror/theme-one-dark, @babel/runtime. With pnpm strict hoisting, install `codemirror @codemirror/state @codemirror/view` explicitly alongside it (one copy of @codemirror/state/view is mandatory, duplicates break the editor). Usage:
```tsx
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
<CodeMirror value={v} onChange={setV} extensions={[markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping]} />
```
(API shape from package README; verify at implementation.) Live preview = render `v` with react-markdown beside it (split pane, debounced). Skip `language-data` if bundle size matters (it lazy-loads per language, so cost is small). Frontmatter: edit the YAML as part of the text, or split fields into a form and body into CodeMirror; decision belongs to phase 4.

## Markdown + wikilinks
react-markdown 10 API: `<Markdown remarkPlugins={[remarkGfm, remarkWikiLinks]} components={{ a: Link }}>{md}</Markdown>`. It is ESM-only, no raw HTML by default (good: safe). Default `urlTransform` strips non-standard protocols, so do not emit `wiki:` URLs; emit an in-app path.
Recommendation: tiny custom remark plugin, zero extra deps, walk mdast manually (text nodes only, skip `code`/`inlineCode` automatically since those are not `text` nodes):
```ts
import type { Root, Text, PhrasingContent, Parent } from 'mdast';
const RE = /\[\[([^\]|#\n]+)(?:\|([^\]\n]+))?\]\]/g;
function split(node: Text): PhrasingContent[] {
  const out: PhrasingContent[] = []; let last = 0;
  for (const m of node.value.matchAll(RE)) {
    if (m.index > last) out.push({ type: 'text', value: node.value.slice(last, m.index) });
    out.push({ type: 'link', url: `/w/${encodeURIComponent(m[1].trim())}`, children: [{ type: 'text', value: (m[2] ?? m[1]).trim() }] });
    last = m.index + m[0].length;
  }
  if (!out.length) return [node];
  if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) });
  return out;
}
export const remarkWikiLinks = () => (tree: Root) => {
  const walk = (p: Parent) => { p.children = p.children.flatMap((c: any) => c.type === 'text' ? split(c) : (c.children && walk(c), [c])); };
  walk(tree);
};
```
(`/w/<slug>` is a client-side resolver route that looks up slug in the current project and redirects, or shows "missing"; alternatively resolve against the project's slug list.) `components.a` renders `<Link to>` from react-router when href starts with `/` and `<a rel="noreferrer">` otherwise. Types: `@types/mdast` comes transitively; add it as devDependency for explicit imports.
Server-side must parse the same `[[slug]]` grammar for edges; put the regex in packages/shared to keep web and server identical. Aliased `[[slug|label]]` support is optional.

## Revision diff
Use `diff` 9.0.0 `diffLines` (and `diffWords` for intra-line) and render in ~40 lines of JSX:
```tsx
import { diffLines } from 'diff';
diffLines(oldBody, newBody).map((p, i) => <pre key={i} className={p.added ? 'bg-green-100' : p.removed ? 'bg-red-100' : ''}>{p.value}</pre>)
```
Gotcha: v9 is ESM with `libcjs` fallback, bundled types; named import `diffLines` is valid. Unified side-by-side view not needed for MVP. Fall back to react-diff-viewer-continued only if split view is demanded.

## Icons
lucide-react 1.58.0: `import { Pin, Archive } from 'lucide-react'` (named imports tree-shake). Note major is 1.x now (the 0.x line ended).

## Components: headless vs shadcn/ui
Recommend NO component library: Tailwind v4 utility classes plus a handful of local components (Button, Input, Badge, Table, Tabs) and native elements (`<dialog>`, `<details>`, `<select>`). shadcn/ui is a CLI that copies code but drags in radix-ui packages, class-variance-authority, clsx, tailwind-merge, tw-animate-css, lucide: 6+ deps and generated files, for an admin UI with few overlays. If an accessible dropdown/popover/dialog is later required, add a single `@radix-ui/react-dialog` (1.3.1, 2026-10-12) or similar on demand. Optional tiny helper: `clsx`.

## Vite dev proxy for /api and /p
Source: https://vite.dev/config/server-options (`server.proxy`: `Record<string, string | ProxyOptions>`, dev-only, keys are path prefixes, `^` prefix = RegExp, options extend http-proxy-3).
```ts
server: {
  port: 5173,
  proxy: {
    '/api': { target: 'http://localhost:3000', changeOrigin: false },
    '/p':   { target: 'http://localhost:3000', changeOrigin: false },
  },
}
```
Gotchas:
1. SPA route collision: `/p/<slug>/mcp` and `/p/<slug>/install.md` belong to the server, so the SPA must NOT use `/p/...` for its own routes (the proxy would swallow browser navigations and reloads). Use `/projects/:slug/...` for SPA project routes. Same in prod: Hono serves `/api`, `/p`, static assets, and falls back to index.html for everything else.
2. Cookie sessions: proxy keeps same-origin, so no CORS; `changeOrigin: false` keeps Host as localhost:5173 so cookie/redirect and device-login URLs stay on the dev origin. If the server builds absolute URLs from Host, check the `X-Forwarded-*` handling (`xfwd: true` option exists in http-proxy).
3. MCP Streamable HTTP uses SSE/streaming; Vite proxy streams responses, but test through it only for UI; agents hit the server port directly in dev.
4. Prefix matching: `'/p'` also matches `/pricing` style paths; use `'^/p/'` to be exact.

## Playwright
@playwright/test 1.64.1. `playwright.config.ts` `webServer` can start the built app (`docker compose up` or `node packages/server/dist`) with `baseURL`; run `npx playwright install --with-deps chromium` in CI (chromium only). Smoke flow: login, browse, edit (type into `.cm-content` via `page.locator('.cm-content').fill(...)`), create token. Use role/label locators; give the CodeMirror editor an `aria-label` through `EditorView.contentAttributes.of({'aria-label': 'Editor'})`. Keep Playwright as a root devDependency or in packages/web, not shipped in the image.

## Recommendation
React 19.3.1 + Vite 8.3.4 + @vitejs/plugin-react 6.1.2 + Tailwind 4.3.3 via @tailwindcss/vite + TanStack Query 5.104.3 + react-router 7.18.4 in data mode (single `react-router` package; v8 is out but needs Node >=22.22 and gains nothing for MVP). Editor: @uiw/react-codemirror 4.25.12 with @codemirror/lang-markdown 6.5.2 (install state/view/codemirror peers explicitly). Rendering: react-markdown 10.1.0 + remark-gfm 4.0.1 with a ~20 line custom wikilink remark plugin (skip unmaintained remark-wiki-link). Diff: `diff` 9.0.0 with custom rendering (skip react-diff-viewer-continued). Icons: lucide-react 1.58.0. No shadcn; plain Tailwind components, add one Radix primitive only if needed. Playwright 1.64.1. Total runtime deps in web: about 14. Keep SPA routes off `/p` and `/api`.

## Sources
- https://vite.dev/config/server-options
- https://reactrouter.com/start/data/installation
- https://tailwindcss.com/docs/installation/using-vite
- npm registry (`npm view`) for all versions, dates, peers, engines.
