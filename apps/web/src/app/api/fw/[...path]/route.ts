// Browser → dashboard server → firewall. See src/lib/proxy.ts for what is forwarded and how it's authenticated.
import { proxy } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path);
}

export async function POST(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path);
}
