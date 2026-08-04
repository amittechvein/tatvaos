import type {
  Organisation, OrgUser, Plan, UserCategory,
} from '@tatvaos/types';

/** Mock admin data. Deleted when packages/api-client lands. */

const GB = 1024 ** 3;

export const MOCK_PLANS: Plan[] = [
  {
    id: 'plan-starter', name: 'Starter', maxUsers: 10,
    storageModel: 'per_user', perUserQuotaBytes: 5 * GB,
    maxDomains: 1, pricePerUserMonthly: 49,
    features: ['Webmail', 'IMAP/POP', 'Mobile apps', 'Spam filtering'],
  },
  {
    id: 'plan-business', name: 'Business', maxUsers: 100,
    storageModel: 'per_user', perUserQuotaBytes: 30 * GB,
    maxDomains: 5, pricePerUserMonthly: 99,
    features: ['Everything in Starter', 'Multiple domains', 'Shared mailboxes', 'Groups', 'Aliases'],
  },
  {
    id: 'plan-institution', name: 'Institution', maxUsers: 500,
    storageModel: 'pooled', pooledStorageBytes: 2048 * GB,
    maxDomains: 10, priceMonthly: 14999,
    features: ['Pooled storage', 'Categories', 'Bulk import', 'Priority support'],
  },
  {
    id: 'plan-enterprise', name: 'Enterprise', maxUsers: null,
    storageModel: 'pooled', pooledStorageBytes: 10240 * GB,
    maxDomains: null, priceMonthly: 49999,
    features: ['Unlimited users', 'DLP', 'Archiving', 'Legal hold', 'SSO', 'Dedicated IP'],
  },
];

export const MOCK_ORGS: Organisation[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Techvein', type: 'business', status: 'active',
    planId: 'plan-business', planName: 'Business',
    storageModel: 'per_user', maxUsers: 100, perUserQuotaBytes: 30 * GB,
    userCount: 12, storageUsedBytes: 84 * GB, domainCount: 2,
    primaryDomain: 'techvein.com',
    adminName: 'Amit Dadhich', adminEmail: 'amit@techvein.com',
    phone: '+91 98765 43210', country: 'India', gstin: '27AABCT1234H1Z5',
    createdAt: '2026-01-14T09:00:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'ABC School', type: 'school', status: 'active',
    planId: 'plan-institution', planName: 'Institution',
    storageModel: 'pooled', maxUsers: 500, pooledStorageBytes: 2048 * GB,
    userCount: 284, storageUsedBytes: 612 * GB, domainCount: 1,
    primaryDomain: 'abcschool.edu.in',
    adminName: 'Sunita Rao', adminEmail: 'principal@abcschool.edu.in',
    phone: '+91 98200 11223', country: 'India',
    createdAt: '2026-03-02T06:30:00Z',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'City Clinic', type: 'hospital', status: 'trial',
    planId: 'plan-business', planName: 'Business',
    storageModel: 'per_user', maxUsers: 100, perUserQuotaBytes: 30 * GB,
    userCount: 8, storageUsedBytes: 11 * GB, domainCount: 1,
    primaryDomain: 'cityclinic.in',
    adminName: 'Dr. Meera Sharma', adminEmail: 'admin@cityclinic.in',
    phone: '+91 99887 66554', country: 'India',
    createdAt: '2026-07-28T11:15:00Z',
    trialEndsAt: '2026-08-27T11:15:00Z',
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    name: 'Rival Corp', type: 'business', status: 'suspended',
    planId: 'plan-starter', planName: 'Starter',
    storageModel: 'per_user', maxUsers: 10, perUserQuotaBytes: 5 * GB,
    userCount: 4, storageUsedBytes: 3 * GB, domainCount: 1,
    primaryDomain: 'rivalcorp.com',
    adminName: 'K. Iyer', adminEmail: 'ceo@rivalcorp.com',
    phone: '+91 90000 12345', country: 'India',
    createdAt: '2026-05-19T14:00:00Z',
  },
];

/** Categories differ by organisation type — that is the point of them. */
export const MOCK_CATEGORIES: Record<string, UserCategory[]> = {
  '22222222-2222-2222-2222-222222222222': [
    { id: 'cat-teach', tenantId: '22222222-2222-2222-2222-222222222222', name: 'Teachers',
      description: 'Teaching staff', defaultQuotaBytes: 15 * GB, defaultRole: 'employee',
      autoGroups: ['staff@abcschool.edu.in'], canSendExternal: true, userCount: 42, colour: '#3563f0' },
    { id: 'cat-stud', tenantId: '22222222-2222-2222-2222-222222222222', name: 'Students',
      description: 'Enrolled students', defaultQuotaBytes: 2 * GB, defaultRole: 'employee',
      autoGroups: [], canSendExternal: false, userCount: 226, colour: '#16a34a' },
    { id: 'cat-admin', tenantId: '22222222-2222-2222-2222-222222222222', name: 'Administration',
      description: 'Office and accounts', defaultQuotaBytes: 20 * GB, defaultRole: 'manager',
      autoGroups: ['staff@abcschool.edu.in', 'office@abcschool.edu.in'],
      canSendExternal: true, userCount: 14, colour: '#a855f7' },
    { id: 'cat-lead', tenantId: '22222222-2222-2222-2222-222222222222', name: 'Leadership',
      description: 'Principal and heads', defaultQuotaBytes: 50 * GB, defaultRole: 'org_admin',
      autoGroups: ['staff@abcschool.edu.in'], canSendExternal: true, userCount: 2, colour: '#ea580c' },
  ],
  '11111111-1111-1111-1111-111111111111': [
    { id: 'cat-eng', tenantId: '11111111-1111-1111-1111-111111111111', name: 'Engineering',
      defaultQuotaBytes: 30 * GB, defaultRole: 'employee', canSendExternal: true, userCount: 6, colour: '#3563f0' },
    { id: 'cat-sales', tenantId: '11111111-1111-1111-1111-111111111111', name: 'Sales',
      defaultQuotaBytes: 30 * GB, defaultRole: 'employee',
      autoGroups: ['sales@techvein.com'], canSendExternal: true, userCount: 3, colour: '#16a34a' },
    { id: 'cat-ops', tenantId: '11111111-1111-1111-1111-111111111111', name: 'Operations',
      defaultQuotaBytes: 30 * GB, defaultRole: 'manager', canSendExternal: true, userCount: 3, colour: '#a855f7' },
  ],
};

function user(
  id: string, tenantId: string, address: string, displayName: string,
  categoryId: string, categoryName: string, p: Partial<OrgUser> = {},
): OrgUser {
  return {
    id, tenantId, mailboxId: `mb-${id}`, address, displayName,
    categoryId, categoryName, role: 'employee', status: 'active',
    quotaBytes: 15 * GB, usedBytes: 2 * GB, mfaEnabled: false,
    lastLoginAt: new Date(Date.now() - 3_600_000).toISOString(),
    createdAt: '2026-03-05T08:00:00Z', ...p,
  };
}

const SCHOOL = '22222222-2222-2222-2222-222222222222';

export const MOCK_ORG_USERS: OrgUser[] = [
  user('u-01', SCHOOL, 'principal@abcschool.edu.in', 'Sunita Rao', 'cat-lead', 'Leadership',
    { role: 'org_owner', quotaBytes: 50 * GB, usedBytes: 22 * GB, mfaEnabled: true }),
  user('u-02', SCHOOL, 'vice.principal@abcschool.edu.in', 'Rajesh Kumar', 'cat-lead', 'Leadership',
    { role: 'org_admin', quotaBytes: 50 * GB, usedBytes: 9 * GB, mfaEnabled: true }),
  user('u-03', SCHOOL, 'accounts@abcschool.edu.in', 'Meena Joshi', 'cat-admin', 'Administration',
    { role: 'manager', quotaBytes: 20 * GB, usedBytes: 7 * GB }),
  user('u-04', SCHOOL, 'admissions@abcschool.edu.in', 'Farah Khan', 'cat-admin', 'Administration',
    { quotaBytes: 20 * GB, usedBytes: 12 * GB }),
  user('u-05', SCHOOL, 'a.desai@abcschool.edu.in', 'Anjali Desai', 'cat-teach', 'Teachers',
    { usedBytes: 4 * GB }),
  user('u-06', SCHOOL, 'v.menon@abcschool.edu.in', 'Vikram Menon', 'cat-teach', 'Teachers',
    { usedBytes: 6 * GB }),
  user('u-07', SCHOOL, 's.pillai@abcschool.edu.in', 'Shalini Pillai', 'cat-teach', 'Teachers',
    { usedBytes: 1 * GB, status: 'suspended', lastLoginAt: null }),
  user('u-08', SCHOOL, 'r.sharma@abcschool.edu.in', 'Rohan Sharma', 'cat-stud', 'Students',
    { quotaBytes: 2 * GB, usedBytes: 0.4 * GB }),
  user('u-09', SCHOOL, 'i.begum@abcschool.edu.in', 'Iqra Begum', 'cat-stud', 'Students',
    { quotaBytes: 2 * GB, usedBytes: 1.7 * GB }),
  user('u-10', SCHOOL, 'k.patel@abcschool.edu.in', 'Kunal Patel', 'cat-stud', 'Students',
    { quotaBytes: 2 * GB, usedBytes: 0.1 * GB, status: 'pending', lastLoginAt: null }),
];

function delay<T>(v: T, ms = 160): Promise<T> {
  return new Promise((r) => setTimeout(() => r(v), ms));
}

export const adminApi = {
  getPlans: () => delay(MOCK_PLANS),
  getOrgs: () => delay(MOCK_ORGS),
  getOrg: (id: string) => delay(MOCK_ORGS.find((o) => o.id === id) ?? null),
  getCategories: (tenantId: string) => delay(MOCK_CATEGORIES[tenantId] ?? []),
  getUsers: (tenantId: string) =>
    delay(MOCK_ORG_USERS.filter((u) => u.tenantId === tenantId)),
};
