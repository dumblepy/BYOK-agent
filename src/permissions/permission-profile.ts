export const USER_SELECTABLE_PERMISSION_PROFILES = [
  "read-only",
  "confirm-writes",
  "workspace-write",
] as const;

export type UserSelectablePermissionProfile = (typeof USER_SELECTABLE_PERMISSION_PROFILES)[number];
export type PermissionProfile = UserSelectablePermissionProfile | "autonomous";

export const PERMISSION_RESTRICTIONS = [
  "commands-disabled",
  "automatic-writes-disabled",
  "workspace-provider-disabled",
  "workspace-mcp-disabled",
] as const;

export type PermissionRestriction = (typeof PERMISSION_RESTRICTIONS)[number];
export type WorkspaceTrustState = "trusted" | "restricted";

export interface PermissionContext {
  readonly requestedProfile: UserSelectablePermissionProfile;
  readonly effectiveProfile: UserSelectablePermissionProfile;
  readonly workspaceTrust: WorkspaceTrustState;
  readonly restrictions: readonly PermissionRestriction[];
  readonly threadRevision: number;
}

export interface PermissionSummary extends PermissionContext {
  readonly threadId: string;
}

export function isUserSelectablePermissionProfile(
  value: unknown,
): value is UserSelectablePermissionProfile {
  return (
    typeof value === "string" &&
    (USER_SELECTABLE_PERMISSION_PROFILES as readonly string[]).includes(value)
  );
}

export function getPermissionRestrictions(
  workspaceTrust: WorkspaceTrustState,
): readonly PermissionRestriction[] {
  return workspaceTrust === "trusted"
    ? []
    : [
        "commands-disabled",
        "automatic-writes-disabled",
        "workspace-provider-disabled",
        "workspace-mcp-disabled",
      ];
}

export function createPermissionSummary(
  threadId: string,
  profile: UserSelectablePermissionProfile,
  revision: number,
  workspaceTrust: WorkspaceTrustState,
): PermissionSummary {
  return {
    threadId,
    requestedProfile: profile,
    effectiveProfile: profile,
    workspaceTrust,
    restrictions: getPermissionRestrictions(workspaceTrust),
    threadRevision: revision,
  };
}

export function isMorePermissivePermissionProfile(
  current: UserSelectablePermissionProfile,
  next: UserSelectablePermissionProfile,
): boolean {
  return permissionProfileRank(next) > permissionProfileRank(current);
}

function permissionProfileRank(profile: UserSelectablePermissionProfile): number {
  switch (profile) {
    case "read-only":
      return 0;
    case "confirm-writes":
      return 1;
    case "workspace-write":
      return 2;
  }
}
