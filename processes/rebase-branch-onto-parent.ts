import { rateLimitedRequest } from "../utils/rate-limited-request.js";

/**
 * Force-resets `branch` to a new commit with the same tree as `parentSha` and parent `parentSha`
 * (same behavior as staging onto production in update-staging-on-production-push).
 * Returns the resolved HEAD sha of `branch` after the operation.
 */
export async function rebaseBranchOntoParentSha(
  octokit: any,
  owner: string,
  repo: string,
  branch: string,
  parentSha: string
): Promise<string> {
  let branchRef: { data: { object: { sha: string } } };
  try {
    branchRef = await rateLimitedRequest(
      () => octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/${branch}`, { owner, repo }),
      { owner, repo, operation: `check ${branch} branch` }
    );
  } catch (error: any) {
    if (error.status === 404) {
      console.log(`[${owner}/${repo}] ❌ ${branch} branch does not exist`);
      return parentSha;
    }
    throw error;
  }

  const branchSha = branchRef.data.object.sha;

  if (branchSha === parentSha) {
    console.log(`[${owner}/${repo}] ${branch} is already at ${parentSha.slice(0, 7)}, skipping rebase`);
    return branchSha;
  }

  const parentCommit = await rateLimitedRequest(
    () =>
      octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner,
        repo,
        commit_sha: parentSha
      }),
    { owner, repo, operation: `get parent commit for ${branch} rebase` }
  );

  const rebaseCommit = await rateLimitedRequest(
    () =>
      octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: `Rebase ${branch} onto parent (${parentSha.slice(0, 7)})`,
        tree: parentCommit.data.tree.sha,
        parents: [parentSha]
      }),
    { owner, repo, operation: `create rebase commit for ${branch}` }
  );

  await rateLimitedRequest(
    () =>
      octokit.request(`PATCH /repos/{owner}/{repo}/git/refs/heads/${branch}`, {
        owner,
        repo,
        sha: rebaseCommit.data.sha,
        force: true
      }),
    { owner, repo, operation: `update ${branch} ref` }
  );

  console.log(`[${owner}/${repo}] Successfully rebased ${branch} onto parent ${parentSha.slice(0, 7)}`);
  return rebaseCommit.data.sha;
}
