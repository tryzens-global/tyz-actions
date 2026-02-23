import { rateLimitedRequest } from "../utils/rate-limited-request.js";

export async function updateReleaseOnStagingPush(octokit: any, owner: string, repo: string) {
  try {
    // Check if release branch exists (optional branch)
    let releaseExists = false;
    try {
      await rateLimitedRequest(
        () => octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/release", { owner, repo }),
        { owner, repo, operation: "check release branch" }
      );
      releaseExists = true;
      console.log(`[${owner}/${repo}] ✅ Release branch exists`);
    } catch (error: any) {
      if (error.status === 404) {
        console.log(`[${owner}/${repo}] ❌ Release branch does not exist, skipping`);
        return;
      }
      throw error;
    }

    if (!releaseExists) {
      return;
    }

    // Get the latest commit SHA from staging branch
    const stagingRef = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/staging", { owner, repo }),
      { owner, repo, operation: "get staging ref" }
    );

    const stagingSha = stagingRef.data.object.sha;

    // Get the latest commit SHA from release branch
    const releaseRef = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/release", { owner, repo }),
      { owner, repo, operation: "get release ref" }
    );

    const releaseSha = releaseRef.data.object.sha;

    // Check if release is already up to date with staging
    if (releaseSha === stagingSha) {
      console.log(`[${owner}/${repo}] Release is already up to date with staging`);
      return;
    }

    // Get the staging commit to get its tree SHA
    const stagingCommit = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner,
        repo,
        commit_sha: stagingSha
      }),
      { owner, repo, operation: "get staging commit" }
    );

    // Create a new commit that rebases release onto staging
    const rebaseCommit = await rateLimitedRequest(
      () => octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: `Rebase release onto staging (${stagingSha.slice(0, 7)})`,
        tree: stagingCommit.data.tree.sha,
        parents: [stagingSha]
      }),
      { owner, repo, operation: "create rebase commit" }
    );

    // Force update the release branch to point to the new rebase commit
    await rateLimitedRequest(
      () => octokit.request("PATCH /repos/{owner}/{repo}/git/refs/heads/release", {
        owner,
        repo,
        sha: rebaseCommit.data.sha,
        force: true
      }),
      { owner, repo, operation: "update release ref" }
    );

    console.log(`[${owner}/${repo}] Successfully rebased release onto staging`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error rebasing release onto staging:`, error.message);
    throw error;
  }
}
