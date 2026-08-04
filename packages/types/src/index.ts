/**
 * Shared domain types.
 *
 * Hand-written for now. Once the .NET API exists these are generated from the
 * OpenAPI document (NSwag/Kiota) so a breaking backend change becomes a
 * compile error in both clients on the same commit.
 */

export type Uuid = string;

/** An organisation. The isolation and billing boundary. */
export interface Tenant {
  id: Uuid;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
}

export interface Domain {
  id: Uuid;
  tenantId: Uuid;
  fqdn: string;
  type: 'primary' | 'alias' | 'independent';
  isActive: boolean;
  verifiedAt: string | null;
}

/**
 * A mailbox is a STORE that receives mail. A user is an identity that
 * authenticates. They are separate on purpose - shared mailboxes exist without
 * a user, and a user reaches mailboxes beyond their own.
 */
export interface Mailbox {
  id: Uuid;
  tenantId: Uuid;
  address: string;
  displayName: string;
  type: 'user' | 'shared' | 'group';
  quotaBytes: number;
  usedBytes: number;
}

export type SpecialUse = '\\Inbox' | '\\Sent' | '\\Drafts' | '\\Junk' | '\\Trash' | null;

export interface Folder {
  id: Uuid;
  mailboxId: Uuid;
  name: string;
  specialUse: SpecialUse;
  unreadCount: number;
  totalCount: number;
}

export interface Address {
  name?: string;
  email: string;
}

export interface Attachment {
  id: Uuid;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Never trust this for rendering decisions - check contentType server-side. */
  isInline: boolean;
}

export interface Message {
  id: Uuid;
  tenantId: Uuid;
  mailboxId: Uuid;
  folderId: Uuid;
  threadId: Uuid | null;
  from: Address;
  to: Address[];
  cc?: Address[];
  subject: string;
  /** Plain-text preview. Safe to render directly. */
  snippet: string;
  /** Attacker-controlled. NEVER render without SafeHtml. */
  bodyHtml?: string;
  bodyText?: string;
  sentAt: string;
  receivedAt: string;
  sizeBytes: number;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  attachments?: Attachment[];
}

export interface Thread {
  id: Uuid;
  subject: string;
  messages: Message[];
  participantCount: number;
}

export type Role =
  | 'super_admin'
  | 'support_engineer'
  | 'org_owner'
  | 'org_admin'
  | 'it_admin'
  | 'manager'
  | 'employee'
  | 'delegate'
  | 'auditor';

export interface Session {
  userId: Uuid;
  tenantId: Uuid;
  tenantName: string;
  mailbox: Mailbox;
  role: Role;
}

/** Delta-sync envelope. Shaped on JMAP so real JMAP is later an adapter. */
export interface SyncChanges<T> {
  sinceToken: string;
  newToken: string;
  added: T[];
  updated: T[];
  removedIds: Uuid[];
  hasMore: boolean;
}

// ============================================================================
//  Administration
// ============================================================================

/**
 * How an organisation's storage is allocated.
 *
 * Both models exist because they suit different customers and price
 * differently. Google Workspace is per-user; Zoho offers both. Making it a
 * per-organisation setting means the commercial decision stays open.
 *
 *   per_user  Each mailbox gets a fixed quota. Predictable, easy to explain,
 *             bills cleanly per seat. Wastes space on light users.
 *   pooled    One allocation shared across every mailbox. Efficient — a school
 *             where the principal needs 30 GB and 200 students need 1 GB each
 *             buys far less total. Harder to reason about when it fills up.
 */
export type StorageModel = 'per_user' | 'pooled';

export interface Plan {
  id: Uuid;
  name: string;
  /** null means unlimited */
  maxUsers: number | null;
  storageModel: StorageModel;
  /** Set when storageModel is 'per_user' */
  perUserQuotaBytes?: number;
  /** Set when storageModel is 'pooled' */
  pooledStorageBytes?: number;
  maxDomains: number | null;
  pricePerUserMonthly?: number;
  priceMonthly?: number;
  features: string[];
}

export type OrgType = 'business' | 'school' | 'hospital' | 'nonprofit' | 'government' | 'other';

/** An organisation as the platform operator sees it. */
export interface Organisation {
  id: Uuid;
  name: string;
  type: OrgType;
  status: 'active' | 'trial' | 'suspended' | 'pending';
  planId: Uuid;
  planName: string;

  storageModel: StorageModel;
  /** Effective limits — may override the plan */
  maxUsers: number | null;
  perUserQuotaBytes?: number;
  pooledStorageBytes?: number;

  userCount: number;
  storageUsedBytes: number;
  domainCount: number;
  primaryDomain: string;

  adminName: string;
  adminEmail: string;
  phone: string;
  country: string;
  gstin?: string;

  createdAt: string;
  trialEndsAt?: string;
}

/**
 * A category groups users and carries defaults — Teachers, Students, Doctors,
 * Reception. Creating fifty accounts one at a time with the same settings is
 * the single most tedious part of onboarding an organisation, and categories
 * are what remove it.
 */
export interface UserCategory {
  id: Uuid;
  tenantId: Uuid;
  name: string;
  description?: string;
  /** Applied to new users in this category. Ignored when storage is pooled. */
  defaultQuotaBytes?: number;
  defaultRole: Role;
  /** Groups every member is added to automatically, e.g. all-staff@ */
  autoGroups?: string[];
  /** Whether members may send outside the organisation. Useful for students. */
  canSendExternal: boolean;
  userCount: number;
  colour: string;
}

export interface OrgUser {
  id: Uuid;
  tenantId: Uuid;
  mailboxId: Uuid;
  address: string;
  displayName: string;
  categoryId: Uuid | null;
  categoryName?: string;
  role: Role;
  status: 'active' | 'suspended' | 'pending';
  quotaBytes: number;
  usedBytes: number;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** What the onboarding wizard collects. */
export interface OnboardingDraft {
  name: string;
  type: OrgType;
  country: string;
  phone: string;
  gstin: string;
  adminName: string;
  adminEmail: string;
  primaryDomain: string;
  planId: string;
  storageModel: StorageModel;
  maxUsers: number | null;
  perUserQuotaGb: number;
  pooledStorageGb: number;
}
