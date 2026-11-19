// /proof: the public, no-login onchain proof page for judges. A signed-in owner is sent to the same view inside the
// dashboard (Activity → Onchain) so the app never drops them on a page without the sidebar.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import PublicProof from "./public-proof";

export const dynamic = "force-dynamic";

export default async function ProofPage() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (verifySession(session)) redirect("/activity?tab=onchain");
  return <PublicProof />;
}
