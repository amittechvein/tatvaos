import type { Plan } from '@tatvaos/types';

// ============================================================================
//  Plan catalogue
// ============================================================================
//
//  What remains of the old adminMock. The fictional organisations, departments
//  and users that used to live here were deleted: they were compiled into the
//  bundle, so staging showed invented customers to whoever signed in. Every
//  console screen now reads the real API.
//
//  Plans stay because they are a static price list rather than somebody's data,
//  and there is no /api/admin/plans endpoint yet. When that lands this file
//  goes with it.
// ============================================================================

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

function delay<T>(v: T, ms = 160): Promise<T> {
  return new Promise((r) => setTimeout(() => r(v), ms));
}

export const adminApi = {
  getPlans: () => delay(MOCK_PLANS),
};
