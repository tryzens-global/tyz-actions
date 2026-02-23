# tyz-actions

A GitHub App that automates Shopify theme deployment, preview theme management, and branch synchronisation between development branches and Shopify GitHub Connector (SGC) branches.

Deployed as a Vercel serverless function that listens for GitHub webhook events (`push` and `pull_request`) and orchestrates file syncing between branches using the GitHub Git Data API.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Workflow Diagram](#workflow-diagram)
- [Branch Structure](#branch-structure)
- [Processes](#processes)
  - [SGC to Parent Sync](#1-sgc-to-parent-sync)
  - [Parent to SGC Sync](#2-parent-to-sgc-sync)
  - [Staging Rebase on Production](#3-staging-rebase-on-production)
  - [One-Way Branch Sync](#4-one-way-branch-sync)
  - [Preview Theme Management](#5-preview-theme-management)
- [Labels](#labels)
- [Repository Variables](#repository-variables)
- [Synced Folders](#synced-folders)
- [Loop Prevention](#loop-prevention)
- [Rate Limiting](#rate-limiting)
- [Setup](#setup)

---

## Architecture Overview

```
GitHub Webhooks
       |
       v
  api/server.ts          (Vercel serverless entry point - receives & routes webhooks)
       |
       ├── processes/update-parent-on-sgc-push.ts      (sgc-* --> production/staging)
       ├── processes/update-sgc-on-parent-push.ts       (production/staging --> sgc-*)
       |                                                (production/staging --> sgc-*-one-way)
       ├── processes/update-staging-on-production-push.ts (rebase staging onto production)
       └── processes/handle-preview-theme.ts            (create/update/delete preview themes)

  utils/rate-limited-request.ts   (rate-limited GitHub API calls with exponential backoff)
```

All Shopify Admin API calls are proxied through `tyz-actions-access.vercel.app` (a separate Shopify app with store access tokens).

---

## Workflow Diagram

```
                         Shopify GitHub Connector
                          |                  |
                    "Update from Shopify"    "Update from Shopify"
                          |                  |
                          v                  v
                   sgc-production        sgc-staging
                          |                  |
                          | (json→prod       | (no sync;
                          |  + rebase)       |  staging never backfills)
                          v                  -
  PR merged --------> production -------> staging
  (pull_request)         |    (rebase)       |
       |                 |                   |
       |          (sync files)        (sync files)
       |                 |                   |
       |                 v                   v
       |          sgc-production        sgc-staging
       |
       |
       |    (if 'sync-settings' label or sync/horizon-* branch)
       |          JSON files included in sgc-production sync
       |
       |
       ├── (if 'preview' label) --> Create/Update Shopify Preview Theme
       |
       |
       v                                     v
  sgc-production-one-way (optional)    sgc-staging-one-way (optional)
  (syncs from production,              (syncs from staging,
   never syncs back)                    never syncs back)
```

### Detailed Event Flow

```
PUSH EVENTS:
============

sgc-production push ("Update from Shopify")
  └─> Sync Shopify files from sgc-production --> production
      (when back sync enabled: .json only, then rebase staging)

sgc-staging push ("Update from Shopify")
  └─> Skipped (staging never backfills from sgc-staging)

production push
  ├─> If from Horizon sync or staging merge:
  |     └─> Rebase staging onto production
  ├─> If from SGC sync:
  |     └─> Rebase staging onto production
  └─> If sgc-production-one-way exists:
        └─> Sync Shopify files from production --> sgc-production-one-way

staging push
  ├─> Sync Shopify files from staging --> sgc-staging
  └─> If sgc-staging-one-way exists:
        └─> Sync Shopify files from staging --> sgc-staging-one-way

sgc-production-one-way push
  └─> (no-op, never syncs back)

sgc-staging-one-way push
  └─> (no-op, never syncs back)


PULL REQUEST EVENTS:
====================

PR labeled 'preview'
  └─> Create or update Shopify preview theme

PR updated (synchronize) with 'preview' label
  └─> Update existing Shopify preview theme

PR merged into production
  ├─> If 'preview' label: delete preview theme
  └─> Sync Shopify files from production --> sgc-production
      (JSON files included if 'sync-settings' label or sync/horizon-* branch)
```

---

## Branch Structure

### Required Branches

| Branch | Description |
|--------|-------------|
| `production` | The main production branch. Represents the live Shopify theme code. |
| `staging` | The staging/development branch. Automatically rebased onto production when production is updated. |
| `sgc-production` | Shopify GitHub Connector branch for the **production** theme. Contains only Shopify theme folder structure. Connected to Shopify via the GitHub connector. |
| `sgc-staging` | Shopify GitHub Connector branch for the **staging** theme. Contains only Shopify theme folder structure. Connected to Shopify via the GitHub connector. |

### Optional Branches

| Branch | Source | Description |
|--------|--------|-------------|
| `sgc-production-one-way` | `production` | Receives Shopify file updates from `production` but **never syncs back**. Useful for connecting a read-only Shopify theme that mirrors production without risk of circular updates. |
| `sgc-staging-one-way` | `staging` | Receives Shopify file updates from `staging` but **never syncs back**. Useful for connecting a read-only Shopify theme that mirrors staging without risk of circular updates. |

> One-way branches are automatically detected. If the branch exists in the repository, syncing is enabled. If it doesn't exist, it's silently skipped.

---

## Processes

### 1. SGC to Parent Sync

**File:** `processes/update-parent-on-sgc-push.ts`

**Trigger:** Push to `sgc-production` or `sgc-staging` with commit message containing "Update from Shopify"

**What it does:** When Shopify pushes theme changes to an SGC branch (via the GitHub Connector), this process syncs those Shopify folder files into the corresponding parent branch (`production` or `staging`).

- Compares file trees between the SGC branch and parent branch
- Only syncs files within Shopify theme folders
- Handles file additions, updates, and deletions
- Reuses existing blobs where possible to minimise API calls
- Falls back to a merge commit if tree-based sync fails

**SGC back sync control:** When `DISABLE_SGC_BACK_SYNC` is **false** or unset (back sync enabled):
- **sgc-production → production**: Only `.json` files are synced (no Liquid, CSS, JS, assets). Staging is then automatically rebased onto production.
- **sgc-staging → staging**: Never backfills (staging does not sync from SGC)

When `DISABLE_SGC_BACK_SYNC` is **true** (back sync disabled): No sync from sgc-production or sgc-staging to their parent branches.

---

### 2. Parent to SGC Sync

**File:** `processes/update-sgc-on-parent-push.ts`

**Trigger:**
- Push to `staging` --> syncs to `sgc-staging` (always includes JSON files)
- PR merged into `production` --> syncs to `sgc-production` (JSON files only with `sync-settings` label or `sync/horizon-*` branch)

**What it does:** Syncs Shopify theme files from a parent branch into its corresponding SGC branch so that Shopify picks up the changes via the GitHub Connector.

- Filters files to only those within Shopify theme folders
- For production syncs, JSON files are excluded by default (to prevent overwriting Shopify customiser settings) unless the `sync-settings` label is present on the PR or the branch name matches `sync/horizon-*`
- For staging syncs, JSON files are always included
- Cleans up any files outside the Shopify folder structure on the SGC branch
- Falls back to a merge commit on conflict

---

### 3. Staging Rebase on Production

**File:** `processes/update-staging-on-production-push.ts`

**Trigger:** Push to `production` (from Horizon sync, staging merge, or SGC sync)

**What it does:** Keeps `staging` in sync with `production` by rebasing staging onto the latest production commit. This ensures staging always has a clean base from production.

- Creates a new commit with production's tree and production as the parent
- Force-updates the staging branch reference
- Skips if staging is already up to date with production

---

### 4. One-Way Branch Sync

**File:** `processes/update-sgc-on-parent-push.ts` (`syncToOneWayBranch`)

**Trigger:**
- Push to `production` --> syncs to `sgc-production-one-way` (if it exists)
- Push to `staging` --> syncs to `sgc-staging-one-way` (if it exists)

**What it does:** Syncs Shopify theme files from a parent branch to its one-way counterpart. One-way branches are designed to be connected to Shopify themes that should mirror a parent branch but never push changes back.

- Only runs if the one-way branch exists in the repository
- Syncs all Shopify folder files (including JSON)
- Handles additions, updates, deletions, and cleanup of non-Shopify files
- Pushes to a one-way branch **never** trigger any further syncing

---

### 5. Preview Theme Management

**File:** `processes/handle-preview-theme.ts`

**Trigger:** PR labelled with `preview`, PR updated with `preview` label, or PR merged with `preview` label

**What it does:** Creates, updates, and deletes Shopify preview themes for pull requests, allowing developers to preview their changes on a live Shopify store before merging.

#### Create (first time `preview` label is added)

1. Extracts the store name from the repository homepage URL (expected format: `https://admin.shopify.com/store/your-store-name`)
2. Downloads the repository archive for the PR's head branch
3. Filters files to Shopify theme folders only
4. Creates a zip archive and uploads it via the `tyz-actions-access` API
5. Creates a new Shopify theme via the Admin API
6. Saves the theme ID to the PR description (wrapped in `[preview-theme-id:123456]`)
7. Polls until the theme is ready, then comments with preview URLs

#### Update (PR pushed with `preview` label)

1. Reads the existing theme ID from the PR description
2. Downloads the updated repository archive
3. Updates theme files in batches of 50 via `themeFilesUpsert`
4. Binary files (fonts, images) are base64-encoded to prevent corruption
5. Comments with updated preview URLs

#### Delete (PR merged with `preview` label)

1. Reads the theme ID from the PR description
2. Deletes the theme via the Admin API
3. Comments confirming deletion

---

## Labels

| Label | Where | Purpose |
|-------|-------|---------|
| `preview` | Pull Request | Creates a Shopify preview theme for the PR. The theme is updated on each push and deleted when the PR is merged. |
| `sync-settings` | Pull Request (into production) | Includes JSON settings files when syncing from `production` to `sgc-production`. Without this label, JSON files are excluded to prevent overwriting Shopify customiser settings. |

---

## Repository Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DISABLE_SGC_BACK_SYNC` | `false` (back sync enabled) | When `false` or unset: sgc-production → production syncs `.json` only + rebase staging; sgc-staging never backfills. When `true`: all back sync disabled. Configure via **Settings > Secrets and variables > Actions > Variables**. |

---

## Synced Folders

Only files within these Shopify theme root folders are synced between branches:

```
assets/        - Static assets (CSS, JS, fonts, images)
blocks/        - Theme blocks
config/        - Theme settings (settings_schema.json, settings_data.json)
layout/        - Theme layouts (theme.liquid, etc.)
locales/       - Translation files
sections/      - Theme sections
snippets/      - Reusable Liquid snippets
templates/     - Page templates and JSON templates
```

All files outside these folders are ignored during syncing and cleaned up from SGC branches.

---

## Loop Prevention

The system prevents infinite sync loops through commit message detection:

1. **Shopify pushes** to SGC branches with messages containing `"Update from Shopify"` -- this triggers a sync to the parent branch
2. **Parent-to-SGC syncs** create commits with messages like `"Sync Shopify files from production"` -- these do **not** contain `"Update from Shopify"`, so when they trigger a push event on the SGC branch, the handler exits without syncing back
3. **Production push handler** only triggers a staging rebase for specific commit patterns (Horizon sync, staging merge, or SGC sync) and explicitly skips other push events to avoid circular updates
4. **One-way branches** always no-op on push, regardless of commit message

---

## Rate Limiting

All GitHub API calls are wrapped with rate-limiting protection (`utils/rate-limited-request.ts`):

- **Automatic retry** with exponential backoff (up to 5 retries)
- **Primary rate limit** handling via `x-ratelimit-remaining` and `x-ratelimit-reset` headers
- **Secondary rate limit** handling with minimum 60-second wait as per GitHub guidelines
- **Batch processing** for bulk operations (e.g., creating blobs) with configurable delays between items and batches
- **50ms minimum delay** between all API requests to stay under secondary rate limits

---

## Setup

### Prerequisites

- Node.js >= 24
- pnpm
- A GitHub App with webhook permissions for `push` and `pull_request` events
- A Vercel account for deployment

### Environment Variables

| Variable | Description |
|----------|-------------|
| `APP_ID` | GitHub App ID |
| `PRIVATE_KEY` | GitHub App private key (newlines can be `\n` escaped) |
| `WEBHOOK_SECRET` | GitHub webhook secret for signature verification |

### Repository Configuration

1. Set the repository **homepage** to the Shopify admin URL: `https://admin.shopify.com/store/your-store-name` (required for preview themes)
2. Create `sgc-production` and `sgc-staging` branches containing only Shopify theme files
3. Connect the SGC branches to Shopify via the GitHub Connector
4. Optionally create `sgc-production-one-way` and/or `sgc-staging-one-way` branches for read-only theme mirrors
5. Optionally set the `DISABLE_SGC_BACK_SYNC` repository variable to `true` to disable all back sync. When `false` or unset, production gets `.json`-only backfill + staging rebase; staging never backfills.

### Development

```bash
pnpm install
pnpm dev      # Starts local Vercel dev server
```
