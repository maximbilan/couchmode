/**
 * Static file server for the web clients, with an optional proxy to a Vite dev
 * server. Node's built-in `http` only - no Express.
 *
 * Routes:
 *   /            -> redirect to /phone
 *   /tv, /phone  -> the corresponding HTML entry point
 *   /*           -> built assets (or proxied to Vite in dev)
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface HttpOptions {
  /** Directory containing the built web client (packages/web/dist). */
  webRoot: string;
  /** When set, every non-API request is proxied here instead (Vite dev server). */
  webDevUrl?: string;
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function serveFile(res: ServerResponse, path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(res);
  return true;
}

function proxy(req: IncomingMessage, res: ServerResponse, target: string): void {
  const url = new URL(req.url ?? "/", target);
  const upstream = httpRequest(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...req.headers, host: url.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => send(res, 502, `dev server unreachable: ${error.message}`));
  req.pipe(upstream);
}

export function createHttpServer(options: HttpOptions): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/healthz") {
      send(res, 200, "ok");
      return;
    }

    if (pathname === "/") {
      res.writeHead(302, { location: `/phone${url.search}` });
      res.end();
      return;
    }

    if (options.webDevUrl) {
      // Vite serves /tv and /phone from tv.html / phone.html at the root.
      if (pathname === "/tv" || pathname === "/phone") {
        req.url = `/${pathname.slice(1)}.html${url.search}`;
      }
      proxy(req, res, options.webDevUrl);
      return;
    }

    void (async () => {
      const root = resolve(options.webRoot);
      if (pathname === "/tv" || pathname === "/phone") {
        if (await serveFile(res, join(root, `${pathname.slice(1)}.html`))) return;
        send(res, 503, "web client is not built yet - run `pnpm --filter @couchmode/web build`");
        return;
      }

      // Reject traversal before touching the filesystem.
      const relative = normalize(pathname)
        .replace(/^(\.\.[/\\])+/, "")
        .replace(/^[/\\]+/, "");
      const target = resolve(root, relative);
      if (target !== root && !target.startsWith(root + sep)) {
        send(res, 403, "forbidden");
        return;
      }
      if (await serveFile(res, target)) return;
      send(res, 404, "not found");
    })();
  });
}
