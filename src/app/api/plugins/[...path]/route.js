import { NextResponse } from "next/server";
import { dispatchPluginRoute } from "@/lib/pluginRuntime.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export async function handler(request, { params }) {
  const { path } = await params;
  if (!path || path.length === 0) {
    return NextResponse.json({ error: "usage: /api/plugins/<plugin>/<route>" }, { status: 400 });
  }
  const pluginName = path[0];
  const pathname = request.url ? new URL(request.url).pathname : `/${path.join("/")}`;
  const method = request.method || "GET";

  const result = await dispatchPluginRoute(pluginName, method, pathname, request);
  if (result) return result;

  return NextResponse.json({ error: `No plugin route: ${method} /api/plugins/${path.join("/")}` }, { status: 404 });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
