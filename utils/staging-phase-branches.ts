/** Branches like staging-phase-2, staging-phase-10 (numeric suffix only). */
export const STAGING_PHASE_BRANCH_RE = /^staging-phase-(\d+)$/;

export function parseStagingPhaseNumber(branch: string): number | null {
  const m = branch.match(STAGING_PHASE_BRANCH_RE);
  if (!m) return null;
  return Number(m[1]);
}

export function isStagingPhaseBranch(branch: string): boolean {
  return STAGING_PHASE_BRANCH_RE.test(branch);
}

/** SGC mirror branch: staging-phase-2 → sgc-staging-phase-2 */
export function sgcBranchForStagingPhase(stagingPhaseBranch: string): string {
  return `sgc-${stagingPhaseBranch}`;
}

/** e.g. sgc-staging-phase-2-one-way */
export function sgcOneWayBranchForStagingPhase(stagingPhaseBranch: string): string {
  return `${sgcBranchForStagingPhase(stagingPhaseBranch)}-one-way`;
}

/** refs/heads/sgc-staging-phase-2 → parent staging-phase-2; one-way refs return null */
export function stagingPhaseParentFromSgcRefBranch(sgcBranch: string): string | null {
  const m = sgcBranch.match(/^sgc-(staging-phase-\d+)$/);
  return m ? m[1] : null;
}

export function isSgcStagingPhaseOneWayBranch(branch: string): boolean {
  return /^sgc-staging-phase-\d+-one-way$/.test(branch);
}
