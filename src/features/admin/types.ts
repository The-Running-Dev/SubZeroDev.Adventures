import type { BrowserDemo } from "../../play/composition";
export interface AdminPanelProps {
  readonly demo: BrowserDemo;
  readonly syncing: boolean;
  readonly syncError: string | undefined;
  /** Locale-formatted time of the last completed sync, or the initial load. */
  readonly lastSyncedAt: string;
  readonly onSync: () => void;
}

export interface AdminCampaignStatus {
  readonly campaignId: string;
  readonly title: string;
  readonly kindId: string;
  readonly version: string;
  readonly endingCount: number;
}

export interface AdminExtensionStatus {
  readonly id: string;
  readonly extends: string;
}

export interface AdminSourceStatus {
  readonly id: string;
  readonly label: string;
  readonly kind: "url" | "pasted";
  readonly url?: string;
  readonly builtin: boolean;
  readonly removable: boolean;
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
}

export interface AdminContentStatus {
  readonly isAdmin: boolean;
  readonly status: {
    readonly campaignCount: number;
    readonly contentDigest?: string;
    readonly lastSuccessAt?: string;
    readonly lastFailureAt?: string;
    readonly lastError?: string;
    readonly bootstrapFallback?: boolean;
  };
  readonly campaigns: readonly AdminCampaignStatus[];
  readonly extensions: readonly AdminExtensionStatus[];
  readonly sources: readonly AdminSourceStatus[];
}

export interface PendingSubmission {
  readonly id: string;
  readonly label: string;
  readonly kind: "url" | "pasted";
  readonly ownerPlayerId?: string;
  readonly lastError?: string;
  readonly quarantineReason?: string;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
}

export interface AddOutcome {
  readonly tone: "ok" | "warn" | "error";
  readonly key?: string;
  readonly error?: unknown;
}
