// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  nitro: {
    // Nitro auto-detects the root index.html and, when it doesn't see an
    // explicit `renderer.handler` registered, wires up its own generic
    // "serve this static file for every route" fallback (`renderer-template`)
    // as a catch-all `/**` route. That fallback wins over TanStack Start's
    // real SSR routing in this nitro/tanstack-start version combo, which is
    // exactly why every route returned the raw index.html instead of a
    // rendered page. This app is fully SSR (loaders + server functions), so
    // Nitro's generic static-SPA renderer is never wanted — disable it.
    //
    // `renderer` is a real, supported Nitro option (see
    // node_modules/nitro/dist/_chunks/nitro.mjs) that @lovable.dev's nitro
    // option type just doesn't list — hence the cast.
    renderer: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
});
