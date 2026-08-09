// Plugin runtime for 9Router — loads git-ignored plugins/ dir, fail-open hooks.
// Survives upstream updates: core only calls runPluginHook() in 2 places + catch-all route.
import { readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

let plugins = [];      // [{ name, version, module, dir }]
let loaded = false;
let loadError = null;

function pluginDirs() {
  const candidates = [];
  if (process.env.PLUGINS_DIR) candidates.push(process.env.PLUGINS_DIR);
  candidates.push(resolve(process.cwd(), "plugins"));
  candidates.push(resolve(process.cwd(), ".next", "standalone", "plugins"));
  candidates.push(resolve(process.cwd(), "..", "plugins"));
  return [...new Set(candidates)].filter((p) => existsSync(p));
}

export async function loadPlugins() {
  if (loaded) return plugins;
  loaded = true;
  plugins = [];
  loadError = null;

  for (const dir of pluginDirs()) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const pluginDir = join(dir, entry.name);
        const entryFile = join(pluginDir, "plugin.js");
        if (!existsSync(entryFile)) continue;
        try {
          const mod = await import(pathToFileURL(entryFile).href + `?t=${Date.now()}`);
          const p = mod.default || mod;
          if (!p || !p.name) continue;
          const rec = { name: p.name, version: p.version || "0.0.0", module: p, dir: pluginDir };
          plugins.push(rec);
          console.log(`[plugins] loaded "${rec.name}" v${rec.version} from ${pluginDir}`);
          try {
            if (typeof p.onInit === "function") await p.onInit({ dir: pluginDir });
          } catch (e) {
            console.error(`[plugins] onInit failed for ${rec.name}:`, e?.message || e);
          }
        } catch (e) {
          console.error(`[plugins] failed to load ${entry.name}:`, e?.message || e);
        }
      }
    } catch (e) {
      loadError = e?.message || String(e);
      console.error(`[plugins] scan failed for ${dir}:`, loadError);
    }
  }
  return plugins;
}

export async function reloadPlugins() {
  loaded = false;
  plugins = [];
  return loadPlugins();
}

export function getPlugins() {
  return plugins.map((p) => ({ name: p.name, version: p.version, dir: p.dir }));
}

/**
 * Run a hook across all plugins. Fail-open: errors are logged, never thrown.
 * Returns first truthy result (used by beforeRequest to block with {status,error}).
 */
export async function runPluginHook(name, ctx = {}) {
  try {
    await loadPlugins();
  } catch {
    /* fail-open */
  }
  for (const p of plugins) {
    try {
      const fn = p.module[name];
      if (typeof fn !== "function") continue;
      const result = await fn(ctx);
      if (result) return result;
    } catch (e) {
      console.error(`[plugins] hook ${name} failed in ${p.name}:`, e?.message || e);
    }
  }
  return null;
}

/**
 * Dispatch an HTTP request to a plugin route.
 * Route table: { "GET /keys": handler, "PUT /keys/:id/limits": handler }
 * handler(req: Request, params: Record<string,string>) => Response
 */
export async function dispatchPluginRoute(pluginName, method, pathname, request) {
  try {
    await loadPlugins();
  } catch {
    /* fail-open */
  }
  const plugin = plugins.find((p) => p.name === pluginName);
  if (!plugin) return null;
  const routes = plugin.module.routes;
  if (!routes || typeof routes !== "object") return null;

  const trimmed = pathname.replace(/^\/api\/plugins\/[^/]+\/?/, "");
  const segments = trimmed.split("/").filter(Boolean);

  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(" ");
    if ((routeMethod || "GET").toUpperCase() !== method.toUpperCase()) continue;
    const routeSegs = routePath.split("/").filter(Boolean);
    if (routeSegs.length !== segments.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < routeSegs.length; i++) {
      if (routeSegs[i].startsWith(":")) {
        params[routeSegs[i].slice(1)] = decodeURIComponent(segments[i]);
      } else if (routeSegs[i] !== segments[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    try {
      return await handler(request, params);
    } catch (e) {
      console.error(`[plugins] route ${key} failed in ${plugin.name}:`, e?.message || e);
      return Response.json({ error: e?.message || "plugin route error" }, { status: 500 });
    }
  }
  return null;
}
