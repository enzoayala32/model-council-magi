import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { applyProposal, discardProposal, getProposal } from "@/lib/fs-tools";
import { guardRequest } from "@/lib/auth/guard";

/**
 * The only place lib/fs-tools.ts writes to disk. A file agent proposal
 * (from propose_write_file / propose_edit_file) sits in memory until the
 * user hits "Apply" in the UI, which POSTs here with the proposal id.
 */
export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;
  const parsed = await readJsonBody<{ proposalId?: string; action?: "apply" | "reject" }>(request);

  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const proposalId = body.proposalId?.trim();
  const action = body.action ?? "apply";
  if (!proposalId) {
    return NextResponse.json({ ok: false, error: "proposalId is required." }, { status: 400 });
  }

  if (action === "reject") {
    const existed = discardProposal(proposalId);
    return NextResponse.json({ ok: true, discarded: existed });
  }

  const proposal = getProposal(proposalId);
  if (!proposal) {
    return NextResponse.json({ ok: false, error: "Proposal not found or expired. Ask the model to propose the change again." }, { status: 404 });
  }

  try {
    await applyProposal(proposalId);
    return NextResponse.json({ ok: true, path: proposal.relPath });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to apply the file change." },
      { status: 500 },
    );
  }
}
