'use client';

import { useEffect, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import { fetchPlans, type PlanRow } from '@/lib/adminData';
import { useAuth } from '@/lib/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { Empty } from '@/components/ui/Kit';

// The plan catalogue, as YZEN pricing cards. Read from GET /admin/plans.
export default function AdminPlansPage() {
  const { authedFetch } = useAuth();
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPlans(authedFetch).then(setPlans).catch(() => setPlans([])).finally(() => setLoading(false));
  }, [authedFetch]);

  return (
    <AdminShell scope="platform" title="Plans" subtitle="The catalogue every organisation is billed against">
      {loading ? (
        <div className="card custom-card"><div className="card-body"><Empty title="Loading…" /></div></div>
      ) : plans.length === 0 ? (
        <div className="card custom-card">
          <div className="card-body">
            <Empty title="No plans yet" hint="Plans are seeded with the database. Once they exist they appear here and can be assigned from any organisation's Manage dialog." />
          </div>
        </div>
      ) : (
        <div className="row">
          {plans.map((p) => (
            <div className="col-xxl-3 col-lg-6 col-md-6" key={p.id}>
              <div className="card custom-card">
                <div className="card-body">
                  <div className="d-flex align-items-center gap-2 mb-3">
                    <span className="avatar avatar-md bg-primary-transparent">
                      <i className="ri-price-tag-3-line fs-18" />
                    </span>
                    <h6 className="fw-semibold mb-0">{p.name}</h6>
                  </div>

                  <div className="mb-3">
                    {p.pricePerUserMonthly ? (
                      <><span className="fs-24 fw-bold">₹{p.pricePerUserMonthly}</span>
                        <span className="text-muted fs-12"> / user / month</span></>
                    ) : p.priceMonthly ? (
                      <><span className="fs-24 fw-bold">₹{p.priceMonthly}</span>
                        <span className="text-muted fs-12"> / month</span></>
                    ) : (
                      <span className="fs-20 fw-semibold text-muted">Custom pricing</span>
                    )}
                  </div>

                  <ul className="list-unstyled fs-13 mb-0">
                    <Feature>{p.maxUsers ? `Up to ${p.maxUsers} people` : 'Unlimited people'}</Feature>
                    <Feature>
                      {p.storageModel === 'pooled'
                        ? `${formatBytes(p.pooledStorageBytes ?? 0)} pooled storage`
                        : `${formatBytes(p.perUserQuotaBytes ?? 0)} per user`}
                    </Feature>
                    <Feature>{p.maxDomains ? `${p.maxDomains} domain${p.maxDomains > 1 ? 's' : ''}` : 'Unlimited domains'}</Feature>
                    <Feature>
                      <span className="text-capitalize">{p.includedProducts.join(', ') || 'mail'}</span>
                    </Feature>
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </AdminShell>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="mb-2 d-flex align-items-start gap-2">
      <i className="ri-checkbox-circle-line text-success" style={{ marginTop: 1 }} />
      <span className="text-muted">{children}</span>
    </li>
  );
}
