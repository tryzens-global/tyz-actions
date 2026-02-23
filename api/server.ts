import { App } from "@octokit/app";
import { Webhooks } from "@octokit/webhooks";
import invariant from "tiny-invariant";
import { createHmac, timingSafeEqual } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";

import { updateParentOnSGCPush } from "../processes/update-parent-on-sgc-push.js";
import { updateStagingOnProductionPush } from "../processes/update-staging-on-production-push.js";
import { updateSGCOnParentPush, syncToOneWayBranch } from "../processes/update-sgc-on-parent-push.js";
import { handlePreviewTheme, deletePreviewTheme } from "../processes/handle-preview-theme.js";

const { APP_ID, PRIVATE_KEY, WEBHOOK_SECRET } = process.env;
invariant(APP_ID, "APP_ID required");
invariant(PRIVATE_KEY, "PRIVATE_KEY required");
invariant(WEBHOOK_SECRET, "WEBHOOK_SECRET required");

const key = PRIVATE_KEY!.includes("\\n") ? PRIVATE_KEY!.replace(/\\n/g, "\n") : PRIVATE_KEY!;
const app = new App({ appId: APP_ID!, privateKey: key });
const webhooks = new Webhooks({ secret: WEBHOOK_SECRET! });
const debug = false;

/**
 * Gets a repository variable value. Returns null if the variable doesn't exist.
 */
async function getRepoVariable(octokit: any, owner: string, repo: string, name: string): Promise<string | null> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/variables/{name}", {
      owner,
      repo,
      name
    });
    return data.value;
  } catch (error: any) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

function checkInstallationId(payload: any) {
  const installationId = payload.installation?.id;
  if (!installationId) {
    if (debug) console.log(`[${payload.repository.owner.login}/${payload.repository.name}] No installation ID found`);
    return false;
  }

  return true;
}

async function checkSgcProductionBranch(octokit: any, owner: string, repo: string): Promise<boolean> {
  try {
    await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/sgc-production", {
      owner,
      repo
    });
    if (debug) console.log(`[${owner}/${repo}] ✅ sgc-production branch exists`);
    return true;
  } catch (error: any) {
    if (error.status === 404) {
      if (debug) console.log(`[${owner}/${repo}] ❌ sgc-production branch does not exist, skipping`);
      return false;
    }
    throw error;
  }
}

async function checkBranchExists(octokit: any, owner: string, repo: string, branch: string): Promise<boolean> {
  try {
    await octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/${branch}`, {
      owner,
      repo
    });
    if (debug) console.log(`[${owner}/${repo}] ✅ ${branch} branch exists`);
    return true;
  } catch (error: any) {
    if (error.status === 404) {
      if (debug) console.log(`[${owner}/${repo}] ❌ ${branch} branch does not exist, skipping`);
      return false;
    }
    throw error;
  }
}

webhooks.on("push", async ({ payload }) => {
  const installationId = payload.installation?.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  if (!checkInstallationId(payload)) return;

  const octokit = await app.getInstallationOctokit(Number(installationId));

  // Check if repository has sgc-production branch
  const hasSgcProductionBranch = await checkSgcProductionBranch(octokit, owner, repo);
  if (!hasSgcProductionBranch) return;

  if (payload.deleted || !payload.head_commit || !payload.head_commit.message) return;

  const headCommitMessage = payload.head_commit.message.toLowerCase();

  switch (payload.ref) {
    case "refs/heads/sgc-production":
      if (headCommitMessage.includes("update from shopify")) {
        // When DISABLE_SGC_BACK_SYNC is false (back sync enabled): JSON-only backfill to production, then rebase staging
        const disableSgcBackSync = await getRepoVariable(octokit, owner, repo, "DISABLE_SGC_BACK_SYNC");
        if (disableSgcBackSync?.toLowerCase() === "true") {
          console.log(`[${owner}/${repo}] DISABLE_SGC_BACK_SYNC - skipping sgc-production to production sync`);
          break;
        }
        console.log(`[${owner}/${repo}] Back sync enabled - syncing only .json files from sgc-production to production, then rebasing staging`);
        await updateParentOnSGCPush(octokit, owner, repo, "production", true);
        await updateStagingOnProductionPush(octokit, owner, repo);
      }
      break;

    case "refs/heads/sgc-staging":
      if (headCommitMessage.includes("update from shopify")) {
        // Staging never backfills from sgc-staging
        console.log(`[${owner}/${repo}] Skipping sgc-staging to staging sync (staging does not backfill)`);
      }
      break;

    case "refs/heads/sgc-production-one-way":
    case "refs/heads/sgc-staging-one-way":
      // One-way branches receive updates but NEVER sync back to any parent branch
      console.log(`[${owner}/${repo}] ${payload.ref.replace("refs/heads/", "")} updated - skipping sync back (one-way branch)`);
      break;

    case "refs/heads/production":
      const productionUpdatedFromSGC = async () => {
        console.log(`[${owner}/${repo}] Production Update from SGC! Rebasing Staging Onto Production`);
        await updateStagingOnProductionPush(octokit, owner, repo);
      }

      const mergeFromHorizonSyncOrStaging = async () => {
        console.log(`[${owner}/${repo}] Merge From Horizon Sync or Staging! Rebasing Staging Onto Production`);
        await updateStagingOnProductionPush(octokit, owner, repo);
      }

      // Handle Staging Updates
      const horizonUpdate = headCommitMessage.includes("merge pull request") && headCommitMessage.includes("/sync/horizon");
      const stagingUpdate = headCommitMessage.includes("merge pull request") && headCommitMessage.includes("/staging");
      const sgcUpdate = headCommitMessage.includes("sync files from sgc-production");

      if (horizonUpdate || stagingUpdate) {
        await mergeFromHorizonSyncOrStaging();
      } else if (sgcUpdate) {
        await productionUpdatedFromSGC();
      } else {
        console.log(`[${owner}/${repo}] Skipping staging update for merge commit to avoid circular updates`);
      }

      // Sync to sgc-production-one-way if it exists (one-way sync, never syncs back)
      if (await checkBranchExists(octokit, owner, repo, "sgc-production-one-way")) {
        console.log(`[${owner}/${repo}] Syncing production to sgc-production-one-way...`);
        await syncToOneWayBranch(octokit, owner, repo, "production", "sgc-production-one-way");
      }

      break;

    case "refs/heads/staging":
      await updateSGCOnParentPush(octokit, owner, repo, false, "staging");

      // Sync to sgc-staging-one-way if it exists (one-way sync, never syncs back)
      if (await checkBranchExists(octokit, owner, repo, "sgc-staging-one-way")) {
        console.log(`[${owner}/${repo}] Syncing staging to sgc-staging-one-way...`);
        await syncToOneWayBranch(octokit, owner, repo, "staging", "sgc-staging-one-way");
      }
      break;
    default:
      return;
  }
});

webhooks.on("pull_request", async ({ payload }) => {
  const installationId = payload.installation?.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  if (!checkInstallationId(payload)) return;

  const octokit = await app.getInstallationOctokit(Number(installationId));

  switch (payload.action) {
    case "labeled":
      const labelName = payload.label?.name?.toLowerCase() || '';

      // Handle when 'preview' label is added to a PR
      if (labelName === 'preview') {
        console.log(`[${owner}/${repo}] Preview label added to PR #${payload.pull_request.number}`);
        await handlePreviewTheme(octokit, owner, repo, payload.pull_request);
        return;
      }

      break;
    case "synchronize":
      // When PR is updated, check if it has the preview label and update the theme
      const hasPreviewLabel = payload.pull_request.labels?.some(
        (label: any) => label.name?.toLowerCase() === 'preview'
      );

      if (hasPreviewLabel) {
        console.log(`[${owner}/${repo}] PR #${payload.pull_request.number} updated, updating preview theme...`);
        await handlePreviewTheme(octokit, owner, repo, payload.pull_request);
        return;
      }

      break;
    case "closed":
      // Handle preview theme deletion when PR is merged
      if (payload.pull_request.merged) {
        const hasPreviewLabel = payload.pull_request.labels?.some(
          (label: any) => label.name?.toLowerCase() === 'preview'
        );

        if (hasPreviewLabel) {
          console.log(`[${owner}/${repo}] PR #${payload.pull_request.number} merged, deleting preview theme...`);
          await deletePreviewTheme(octokit, owner, repo, payload.pull_request);
        }
      }

      // Only process when PR is merged into production
      if (!payload.pull_request.merged || payload.pull_request.base.ref !== "production") {
        return;
      }

      // Check if repository has sgc-production branch
      const hasSgcProductionBranch = await checkSgcProductionBranch(octokit, owner, repo);
      if (!hasSgcProductionBranch) return;

      // Check if PR has the 'sync-settings' label to include JSON files
      const prHeadRef = payload.pull_request.head.ref?.toLowerCase() || '';
      const shouldIncludeJson = payload.pull_request.labels?.some(
        (label: any) => label.name?.toLowerCase() === 'sync-settings'
      ) || prHeadRef.includes('sync/horizon-');

      if (debug) console.log(`[${owner}/${repo}] Including JSON files: ${shouldIncludeJson} (PR head ref: ${payload.pull_request.head.ref})`);

      // Update sgc-production when production is updated
      // Note: staging updates are handled by the push webhook, not here
      await updateSGCOnParentPush(octokit, owner, repo, shouldIncludeJson, "production");
      break;
    default:
      return;
  }
});

webhooks.onError((err) => {
  console.error("[webhook:error]", {
    name: err.name,
    message: err.message,
    event: (err as any).event,
    requestHeaders: (err as any).request?.headers && {
      event: (err as any).request.headers["x-github-event"],
      delivery: (err as any).request.headers["x-github-delivery"],
      sig256: ((err as any).request.headers["x-hub-signature-256"] || "").toString().slice(0, 20) + "…",
    },
  });
});

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") { res.statusCode = 200; res.end("ok"); return; }

  const raw = await readRawBody(req);
  const secret = process.env.WEBHOOK_SECRET || "";
  const got = String(req.headers["x-hub-signature-256"] || "");
  const exp = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

  const eq = got.length === exp.length && timingSafeEqual(Buffer.from(got), Buffer.from(exp));

  if (!eq) { res.statusCode = 401; res.end("signature mismatch"); return; }

  // If signature matches, let Octokit parse & dispatch using the same raw bytes
  await webhooks.verifyAndReceive({
    id: String(req.headers["x-github-delivery"] || ""),
    name: String(req.headers["x-github-event"] || "") as any,
    payload: raw.toString("utf8"),
    signature: got
  }).catch(err => {
    console.error("[webhook:error]", err);
    res.statusCode = 400;
    res.end("webhook error");
  });

  res.statusCode = 200;
  res.end("ok");
}