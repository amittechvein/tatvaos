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
  name: string;
  specialUse: SpecialUse;
  /**
   * Stable route name for special folders — 'inbox', 'sent', 'drafts',
   * 'junk', 'trash'. The inbox is /mail/inbox for everyone, rather than a
   * GUID that differs per mailbox. Null for custom folders, which are
   * addressed by id.
   */
  slug: string | null;
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
 * A department — what Google calls an Organisational Unit.
 *
 * Hierarchical: parentId nests it, and a null defaultQuotaBytes means INHERIT
 * from the parent rather than "unset". That distinction is the whole point of
 * the tree, so it must survive into the client types.
 */
export interface Department {
  id: Uuid;
  tenantId: Uuid;
  name: string;
  description?: string;
  /**
   * Applied to new users here. NULL/undefined means INHERIT from the parent,
   * not "unset" — that distinction is the point of the tree.
   */
  defaultQuotaBytes?: number;
  defaultRole: Role;
  /** null for a top-level department. */
  parentId: string | null;
  /**
   * Which products a new user here receives. A school buys Drive for its staff
   * and not for its 400 students, so this belongs on the department rather
   * than on the organisation.
   */
  defaultProducts: string[];
  /** Groups every member is added to automatically, e.g. all-staff@ */
  autoGroups?: string[];
  /** Whether members may send outside the organisation. Useful for students. */
  canSendExternal: boolean;
  userCount: number;
  colour: string;
}

/**
 * A PERSON, from core.users — not a mailbox.
 *
 * The distinction is load-bearing. `id` identifies the human across every
 * TatvaOS product, so suspending them or resetting their password is one call
 * that covers Mail, Drive and Payroll. A mailbox is something Mail grants
 * them, which is why `mailboxAddress` is nullable: a Payroll-only worker needs
 * a payslip and no email account, and that is a normal state rather than an
 * error to code around.
 *
 * `email` is the sign-in identity and usually equals the mailbox address, but
 * they are separate fields because they are separate things.
 */
export interface OrgUser {
  id: Uuid;
  email: string;
  displayName: string;
  /** Null when the person has no mailbox. */
  mailboxAddress: string | null;
  departmentId: Uuid | null;
  departmentName?: string;
  role: Role;
  status: 'active' | 'suspended' | 'pending' | 'deleted';
  /** Product codes this person can use: 'mail', 'drive', 'payroll', … */
  products: string[];
  /** Mailbox quota. Zero when there is no mailbox. */
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
