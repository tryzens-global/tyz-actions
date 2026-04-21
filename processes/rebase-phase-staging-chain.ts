import { rateLimitedRequest } from "../utils/rate-limited-request.js";
import { isStagingPhaseBranch, parseStagingPhaseNumber } from "../utils/staging-phase-branches.js";
import { rebaseBranchOntoParentSha } from "./rebase-branch-onto-parent.js";

export async function listStagingPhaseBranches(octokit: any, owner: string, repo: string): Promise<string[]> {
  try {
    const { data } = await rateLimitedRequest(
      () =>
        octokit.request("GET /repos/{owner}/{repo}/git/matching-refs/{ref}", {
          owner,
          repo,
          ref: "heads/staging-phase-"
        }),
      { owner, repo, operation: "list staging-phase-* refs" }
    );

    const names = (data as { ref: string }[])
      .map((r) => r.ref.replace("refs/heads/", ""))
      .filter((name) => isStagingPhaseBranch(name));

    return names.sort((a, b) => {
      const na = parseStagingPhaseNumber(a)!;
      const nb = parseStagingPhaseNumber(b)!;
      return na - nb;
    });
  } catch (error: any) {
    if (error.status === 404) {
      return [];
    }
    throw error;
  }
}

/**
 * After `staging` or a `staging-phase-N` branch moves, rebase downstream phase branches so that:
 * production → staging → staging-phase-2 → staging-phase-3 → … (by numeric order).
 */
export async function rebaseDownstreamPhaseStagingBranches(
  octokit: any,
  owner: string,
  repo: string,
  updatedBranch: "staging" | string
): Promise<void> {
  const phases = await listStagingPhaseBranches(octokit, owner, repo);
  if (phases.length === 0) {
    return;
  }

  let minPhaseExclusive = 0;
  if (updatedBranch !== "staging") {
    const n = parseStagingPhaseNumber(updatedBranch);
    if (n === null) {
      return;
    }
    minPhaseExclusive = n;
  }

  const downstream = phases.filter((b) => parseStagingPhaseNumber(b)! > minPhaseExclusive);
  if (downstream.length === 0) {
    return;
  }

  const updatedRef = await rateLimitedRequest(
    () =>
      octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/${updatedBranch}`, {
        owner,
        repo
      }),
    { owner, repo, operation: `get ${updatedBranch} ref for phase chain` }
  );
  let parentSha: string = updatedRef.data.object.sha;

  for (const phaseBranch of downstream) {
    parentSha = await rebaseBranchOntoParentSha(octokit, owner, repo, phaseBranch, parentSha);
  }
}
