import { rateLimitedRequest, batchProcess } from "../utils/rate-limited-request.js";

/**
 * Syncs files from a source SGC branch to its one-way counterpart.
 * One-way branches receive updates but never sync back to any parent branch.
 *
 * @param sourceBranch - The source branch to sync from (e.g. "sgc-production", "sgc-staging")
 * @param targetBranch - The one-way target branch (e.g. "sgc-production-one-way", "sgc-staging-one-way")
 */
export async function syncToOneWayBranch(octokit: any, owner: string, repo: string, sourceBranch: string, targetBranch: string): Promise<void> {
  try {
    // Get the latest commit SHA from source branch
    const sourceRef = await rateLimitedRequest(
      () => octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/${sourceBranch}`, { owner, repo }),
      { owner, repo, operation: `get ${sourceBranch} ref` }
    );

    const sourceSha = sourceRef.data.object.sha;

    // Get the latest commit SHA from target one-way branch
    const targetRef = await rateLimitedRequest(
      () => octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/${targetBranch}`, { owner, repo }),
      { owner, repo, operation: `get ${targetBranch} ref` }
    );

    const targetSha = targetRef.data.object.sha;

    // Get the source tree to find Shopify-specific folders
    const sourceTree = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: sourceSha,
        recursive: "true"
      }),
      { owner, repo, operation: `get ${sourceBranch} tree` }
    );

    // Define the specific Shopify folders to sync
    const shopifyFolders = [
      'assets',
      'blocks',
      'config',
      'layout',
      'locales',
      'sections',
      'snippets',
      'templates'
    ];

    // Filter for files in the specified Shopify folders
    const shopifyFiles = sourceTree.data.tree.filter((item: any) => {
      if (item.type !== "blob") return false;

      // Check if file is in one of the specified folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        item.path.startsWith(folder + '/') || item.path === folder
      );

      return isInShopifyFolder;
    });

    console.log(`[${owner}/${repo}] Found ${shopifyFiles.length} Shopify files in ${sourceBranch} to sync to ${targetBranch}`);

    if (shopifyFiles.length === 0) {
      console.log(`[${owner}/${repo}] No Shopify files found in ${sourceBranch} to sync`);
      return;
    }

    // Get the current target tree
    const targetTree = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: targetSha,
        recursive: "true"
      }),
      { owner, repo, operation: `get ${targetBranch} tree` }
    );

    // Create a map of existing files in target by path
    const targetFiles = new Map();
    // Create a set of all blob SHAs that exist in target (for reuse)
    const targetBlobShas = new Set<string>();
    targetTree.data.tree.forEach((item: any) => {
      if (item.type === "blob") {
        targetFiles.set(item.path, item.sha);
        targetBlobShas.add(item.sha);
      }
    });

    // Create a set of source file paths for deletion detection
    const sourceFilePaths = new Set(shopifyFiles.map((f: any) => f.path));

    // Prepare tree updates
    const treeUpdates: any[] = [];
    let filesUpdated = 0;
    let filesAdded = 0;
    // Track which blob SHAs we need to fetch (only for blobs that don't exist in target)
    const blobsToFetch = new Map<string, any>();

    for (const shopifyFile of shopifyFiles) {
      // Check if this file exists in target
      if (targetFiles.has(shopifyFile.path)) {
        // Check if the file content is different
        const targetFileSha = targetFiles.get(shopifyFile.path);
        if (targetFileSha === shopifyFile.sha) {
          console.log(`[${owner}/${repo}] File ${shopifyFile.path} is already up to date, skipping`);
          continue;
        }
      }

      // If the blob SHA already exists in target, we can reuse it (no API calls needed!)
      if (targetBlobShas.has(shopifyFile.sha)) {
        // Blob already exists in target, just reference it
        treeUpdates.push({
          path: shopifyFile.path,
          mode: shopifyFile.mode,
          type: "blob",
          sha: shopifyFile.sha
        });

        if (targetFiles.has(shopifyFile.path)) {
          filesUpdated++;
          console.log(`[${owner}/${repo}] Updated ${shopifyFile.path} (reused existing blob)`);
        } else {
          filesAdded++;
          console.log(`[${owner}/${repo}] Added ${shopifyFile.path} (reused existing blob)`);
        }
      } else {
        // Blob doesn't exist in target, we need to fetch and create it
        // Batch these for later to minimize API calls
        blobsToFetch.set(shopifyFile.sha, shopifyFile);
      }
    }

    // Fetch and create blobs only for files that need new blobs
    const blobEntries = Array.from(blobsToFetch.entries());
    await batchProcess(
      blobEntries,
      async ([blobSha, shopifyFile]) => {
        // Get the blob content from source
        const blob = await rateLimitedRequest(
          () => octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
            owner,
            repo,
            file_sha: blobSha
          }),
          { owner, repo, operation: `get blob ${shopifyFile.path}` }
        );

        // Create a new blob in target with the content from source
        const newBlob = await rateLimitedRequest(
          () => octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
            owner,
            repo,
            content: blob.data.content,
            encoding: blob.data.encoding
          }),
          { owner, repo, operation: `create blob ${shopifyFile.path}` }
        );

        // Add to tree updates
        treeUpdates.push({
          path: shopifyFile.path,
          mode: shopifyFile.mode,
          type: "blob",
          sha: newBlob.data.sha
        });

        if (targetFiles.has(shopifyFile.path)) {
          filesUpdated++;
          console.log(`[${owner}/${repo}] Updated ${shopifyFile.path}`);
        } else {
          filesAdded++;
          console.log(`[${owner}/${repo}] Added ${shopifyFile.path}`);
        }
      },
      { owner, repo, batchSize: 10, delayBetweenBatches: 500, delayBetweenItems: 75 }
    );

    // Handle deletions: files that exist in target but not in source (only in Shopify folders)
    let filesDeleted = 0;
    for (const [filePath, fileSha] of targetFiles.entries()) {
      // Only delete files within Shopify folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        filePath.startsWith(folder + '/') || filePath === folder
      );

      if (!isInShopifyFolder) {
        continue; // Skip files outside Shopify folders
      }

      // If file exists in target but not in source, mark for deletion
      if (!sourceFilePaths.has(filePath)) {
        treeUpdates.push({
          path: filePath,
          mode: "100644", // Standard file mode
          type: "blob",
          sha: null // Setting sha to null deletes the file
        });
        filesDeleted++;
        console.log(`[${owner}/${repo}] Deleted ${filePath} (not in ${sourceBranch})`);
      }
    }

    // Cleanup fallback: Remove any files outside Shopify folder structure
    let filesCleanedUp = 0;
    for (const [filePath, fileSha] of targetFiles.entries()) {
      // Check if file is in one of the Shopify folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        filePath.startsWith(folder + '/') || filePath === folder
      );

      // If file is outside Shopify folders, remove it
      if (!isInShopifyFolder) {
        // Check if this file is already in treeUpdates (to avoid duplicates)
        const alreadyInUpdates = treeUpdates.some(update => update.path === filePath);
        if (!alreadyInUpdates) {
          treeUpdates.push({
            path: filePath,
            mode: "100644", // Standard file mode
            type: "blob",
            sha: null // Setting sha to null deletes the file
          });
          filesCleanedUp++;
          console.log(`[${owner}/${repo}] Cleaned up ${filePath} (outside Shopify folder structure)`);
        }
      }
    }

    if (treeUpdates.length === 0) {
      console.log(`[${owner}/${repo}] No Shopify files to update in ${targetBranch}`);
      return;
    }

    // Create a new tree with the updated files
    const newTree = await rateLimitedRequest(
      () => octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo,
        base_tree: targetSha,
        tree: treeUpdates
      }),
      { owner, repo, operation: "create tree" }
    );

    // Create commit message
    const commitParts: string[] = [];
    if (filesAdded > 0) {
      commitParts.push(`${filesAdded} added`);
    }
    if (filesUpdated > 0) {
      commitParts.push(`${filesUpdated} updated`);
    }
    if (filesDeleted > 0) {
      commitParts.push(`${filesDeleted} deleted`);
    }
    if (filesCleanedUp > 0) {
      commitParts.push(`${filesCleanedUp} cleaned up`);
    }
    const commitMessage = `Sync Shopify files from ${sourceBranch} (${commitParts.join(', ')})`;

    // Create a new commit
    const newCommit = await rateLimitedRequest(
      () => octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: commitMessage,
        tree: newTree.data.sha,
        parents: [targetSha]
      }),
      { owner, repo, operation: "create commit" }
    );

    // Update the target branch to point to the new commit
    await rateLimitedRequest(
      () => octokit.request(`PATCH /repos/{owner}/{repo}/git/refs/heads/${targetBranch}`, {
        owner,
        repo,
        sha: newCommit.data.sha
      }),
      { owner, repo, operation: `update ${targetBranch} ref` }
    );

    const syncParts: string[] = [];
    if (filesAdded > 0) {
      syncParts.push(`${filesAdded} added`);
    }
    if (filesUpdated > 0) {
      syncParts.push(`${filesUpdated} updated`);
    }
    if (filesDeleted > 0) {
      syncParts.push(`${filesDeleted} deleted`);
    }
    if (filesCleanedUp > 0) {
      syncParts.push(`${filesCleanedUp} cleaned up`);
    }
    const totalFiles = filesAdded + filesUpdated + filesDeleted + filesCleanedUp;
    console.log(`[${owner}/${repo}] Successfully synced ${totalFiles} files from ${sourceBranch} to ${targetBranch} (${syncParts.join(', ')})`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error syncing Shopify files from ${sourceBranch} to ${targetBranch}:`, error.message);

    // If sync fails, try a simpler approach - create a merge commit
    if (error.status === 422 || error.message.includes('conflict')) {
      try {
        await rateLimitedRequest(
          () => octokit.request("POST /repos/{owner}/{repo}/merges", {
            owner,
            repo,
            base: targetBranch,
            head: sourceBranch,
            commit_message: `Merge ${sourceBranch} into ${targetBranch} (fallback from Shopify sync)`
          }),
          { owner, repo, operation: "fallback merge" }
        );
        console.log(`[${owner}/${repo}] Fallback: merged ${sourceBranch} into ${targetBranch}`);
      } catch (mergeError: any) {
        console.error(`[${owner}/${repo}] Fallback merge also failed:`, mergeError.message);
      }
    }
  }
}

export async function updateSGCOnParentPush(octokit: any, owner: string, repo: string, includeJsonFiles: boolean = false, parent: "staging" | "production" | "release") {
  try {
    // Automatically include JSON files when updating sgc-staging or sgc-release
    const shouldIncludeJson = includeJsonFiles || parent === "staging" || parent === "release";

    // Get the latest commit SHA from ${parent} branch
    const parentRef = await rateLimitedRequest(
      () => octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/${parent}`, { owner, repo }),
      { owner, repo, operation: `get ${parent} ref` }
    );

    const parentSha = parentRef.data.object.sha;

    // Get the latest commit SHA from sgc-${parent} branch
    const sgcRef = await rateLimitedRequest(
      () => octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/sgc-${parent}`, { owner, repo }),
      { owner, repo, operation: `get sgc-${parent} ref` }
    );

    const sgcSha = sgcRef.data.object.sha;

    // Get the parent tree to find Shopify-specific folders
    const parentTree = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: parentSha,
        recursive: "true"
      }),
      { owner, repo, operation: `get ${parent} tree` }
    );

    // Define the specific Shopify folders to sync
    const shopifyFolders = [
      'assets',
      'blocks',
      'config',
      'layout',
      'locales',
      'sections',
      'snippets',
      'templates'
    ];

    // Filter for files in the specified Shopify folders, excluding JSON files
    const shopifyFiles = parentTree.data.tree.filter((item: any) => {
      if (item.type !== "blob") return false;

      // Check if file is in one of the specified folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        item.path.startsWith(folder + '/') || item.path === folder
      );

      // Always include config/settings_schema.json regardless of JSON file filtering
      const isSettingsSchema = item.path === 'config/settings_schema.json';

      // Conditionally exclude JSON files based on parameter, but always include settings_schema.json
      // Automatically include JSON files when updating sgc-staging
      const isNotJson = shouldIncludeJson || !item.path.endsWith('.json') || isSettingsSchema;

      return isInShopifyFolder && isNotJson;
    });

    console.log(`[${owner}/${repo}] Found ${shopifyFiles.length} Shopify files in ${parent} to sync`);

    if (shopifyFiles.length === 0) {
      console.log(`[${owner}/${repo}] No Shopify files found in ${parent} to sync`);
      return;
    }

    // Get the current sgc-${parent} tree
    const sgcTree = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: sgcSha,
        recursive: "true"
      }),
      { owner, repo, operation: `get sgc-${parent} tree` }
    );

    // Create a map of existing files in sgc-${parent} by path
    const sgcFiles = new Map();
    // Create a set of all blob SHAs that exist in sgc-${parent} (for reuse)
    const sgcBlobShas = new Set<string>();
    sgcTree.data.tree.forEach((item: any) => {
      if (item.type === "blob") {
        sgcFiles.set(item.path, item.sha);
        sgcBlobShas.add(item.sha);
      }
    });

    // Create a set of parent file paths for deletion detection
    const parentFilePaths = new Set(shopifyFiles.map((f: any) => f.path));

    // Prepare tree updates
    const treeUpdates: any[] = [];
    let filesUpdated = 0;
    let filesAdded = 0;
    // Track which blob SHAs we need to fetch (only for blobs that don't exist in target)
    const blobsToFetch = new Map<string, any>();

    for (const shopifyFile of shopifyFiles) {
      // Check if this file exists in sgc-${parent}
      if (sgcFiles.has(shopifyFile.path)) {
        // Check if the file content is different
        const sgcFileSha = sgcFiles.get(shopifyFile.path);
        if (sgcFileSha === shopifyFile.sha) {
          console.log(`[${owner}/${repo}] File ${shopifyFile.path} is already up to date, skipping`);
          continue;
        }
      }

      // If the blob SHA already exists in sgc-${parent}, we can reuse it (no API calls needed!)
      if (sgcBlobShas.has(shopifyFile.sha)) {
        // Blob already exists in target, just reference it
        treeUpdates.push({
          path: shopifyFile.path,
          mode: shopifyFile.mode,
          type: "blob",
          sha: shopifyFile.sha
        });

        if (sgcFiles.has(shopifyFile.path)) {
          filesUpdated++;
          console.log(`[${owner}/${repo}] Updated ${shopifyFile.path} (reused existing blob)`);
        } else {
          filesAdded++;
          console.log(`[${owner}/${repo}] Added ${shopifyFile.path} (reused existing blob)`);
        }
      } else {
        // Blob doesn't exist in target, we need to fetch and create it
        // Batch these for later to minimize API calls
        blobsToFetch.set(shopifyFile.sha, shopifyFile);
      }
    }

    // Fetch and create blobs only for files that need new blobs
    // Process in batches with rate limiting
    const blobEntries = Array.from(blobsToFetch.entries());
    await batchProcess(
      blobEntries,
      async ([blobSha, shopifyFile]) => {
        // Get the blob content from ${parent}
        const blob = await rateLimitedRequest(
          () => octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
            owner,
            repo,
            file_sha: blobSha
          }),
          { owner, repo, operation: `get blob ${shopifyFile.path}` }
        );

        // Create a new blob in sgc-${parent} with the content from ${parent}
        const newBlob = await rateLimitedRequest(
          () => octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
            owner,
            repo,
            content: blob.data.content,
            encoding: blob.data.encoding
          }),
          { owner, repo, operation: `create blob ${shopifyFile.path}` }
        );

        // Add to tree updates
        treeUpdates.push({
          path: shopifyFile.path,
          mode: shopifyFile.mode,
          type: "blob",
          sha: newBlob.data.sha
        });

        if (sgcFiles.has(shopifyFile.path)) {
          filesUpdated++;
          console.log(`[${owner}/${repo}] Updated ${shopifyFile.path}`);
        } else {
          filesAdded++;
          console.log(`[${owner}/${repo}] Added ${shopifyFile.path}`);
        }
      },
      { owner, repo, batchSize: 10, delayBetweenBatches: 500, delayBetweenItems: 75 }
    );

    // Handle deletions: files that exist in sgc-${parent} but not in parent (only in Shopify folders)
    let filesDeleted = 0;
    for (const [filePath, fileSha] of sgcFiles.entries()) {
      // Only delete files within Shopify folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        filePath.startsWith(folder + '/') || filePath === folder
      );

      if (!isInShopifyFolder) {
        continue; // Skip files outside Shopify folders
      }

      // Check if this file should be excluded based on JSON filtering (same logic as shopifyFiles filter)
      const isSettingsSchema = filePath === 'config/settings_schema.json';
      const isJsonFile = filePath.endsWith('.json');
      const shouldExcludeJson = !shouldIncludeJson && isJsonFile && !isSettingsSchema;

      if (shouldExcludeJson) {
        continue; // Skip excluded JSON files
      }

      // If file exists in sgc but not in parent, mark for deletion
      if (!parentFilePaths.has(filePath)) {
        treeUpdates.push({
          path: filePath,
          mode: "100644", // Standard file mode
          type: "blob",
          sha: null // Setting sha to null deletes the file
        });
        filesDeleted++;
        console.log(`[${owner}/${repo}] Deleted ${filePath} (not in ${parent})`);
      }
    }

    // Cleanup fallback: Remove any files outside Shopify folder structure
    let filesCleanedUp = 0;
    for (const [filePath, fileSha] of sgcFiles.entries()) {
      // Check if file is in one of the Shopify folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        filePath.startsWith(folder + '/') || filePath === folder
      );

      // If file is outside Shopify folders, remove it
      if (!isInShopifyFolder) {
        // Check if this file is already in treeUpdates (to avoid duplicates)
        const alreadyInUpdates = treeUpdates.some(update => update.path === filePath);
        if (!alreadyInUpdates) {
          treeUpdates.push({
            path: filePath,
            mode: "100644", // Standard file mode
            type: "blob",
            sha: null // Setting sha to null deletes the file
          });
          filesCleanedUp++;
          console.log(`[${owner}/${repo}] Cleaned up ${filePath} (outside Shopify folder structure)`);
        }
      }
    }

    if (treeUpdates.length === 0) {
      console.log(`[${owner}/${repo}] No Shopify files to update in sgc-${parent}`);
      return;
    }

    // Create a new tree with the updated files
    const newTree = await rateLimitedRequest(
      () => octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo,
        base_tree: sgcSha,
        tree: treeUpdates
      }),
      { owner, repo, operation: "create tree" }
    );

    // Create commit message
    const commitParts: string[] = [];
    if (filesAdded > 0) {
      commitParts.push(`${filesAdded} added`);
    }
    if (filesUpdated > 0) {
      commitParts.push(`${filesUpdated} updated`);
    }
    if (filesDeleted > 0) {
      commitParts.push(`${filesDeleted} deleted`);
    }
    if (filesCleanedUp > 0) {
      commitParts.push(`${filesCleanedUp} cleaned up`);
    }
    const commitMessage = `Sync Shopify files from ${parent} (${commitParts.join(', ')})`;

    // Create a new commit
    const newCommit = await rateLimitedRequest(
      () => octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: commitMessage,
        tree: newTree.data.sha,
        parents: [sgcSha]
      }),
      { owner, repo, operation: "create commit" }
    );

    // Update the sgc-${parent} branch to point to the new commit
    await rateLimitedRequest(
      () => octokit.request(`PATCH /repos/{owner}/{repo}/git/refs/heads/sgc-${parent}`, {
        owner,
        repo,
        sha: newCommit.data.sha
      }),
      { owner, repo, operation: `update sgc-${parent} ref` }
    );

    const syncParts: string[] = [];
    if (filesAdded > 0) {
      syncParts.push(`${filesAdded} added`);
    }
    if (filesUpdated > 0) {
      syncParts.push(`${filesUpdated} updated`);
    }
    if (filesDeleted > 0) {
      syncParts.push(`${filesDeleted} deleted`);
    }
    if (filesCleanedUp > 0) {
      syncParts.push(`${filesCleanedUp} cleaned up`);
    }
    const totalFiles = filesAdded + filesUpdated + filesDeleted + filesCleanedUp;
    console.log(`[${owner}/${repo}] Successfully synced ${totalFiles} files from ${parent} to sgc-${parent} (${syncParts.join(', ')})`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error syncing Shopify files from ${parent}:`, error.message);

    // If sync fails, try a simpler approach - create a merge commit
    if (error.status === 422 || error.message.includes('conflict')) {
      try {
        await rateLimitedRequest(
          () => octokit.request("POST /repos/{owner}/{repo}/merges", {
            owner,
            repo,
            base: `sgc-${parent}`,
            head: parent,
            commit_message: `Merge ${parent} into sgc-${parent} (fallback from Shopify sync)`
          }),
          { owner, repo, operation: "fallback merge" }
        );
        console.log(`[${owner}/${repo}] Fallback: merged ${parent} into sgc-${parent}`);
      } catch (mergeError: any) {
        console.error(`[${owner}/${repo}] Fallback merge also failed:`, mergeError.message);
      }
    }
  }
}
