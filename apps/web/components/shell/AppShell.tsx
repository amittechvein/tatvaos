'use client';

import { Sidebar, type NavSection } from './Sidebar';
import { Topbar } from './Topbar';

// ============================================================================
//  Shell — YZEN's .page / .app-content structure
// ============================================================================
//
//  YZEN positions the rail and offsets the content entirely in CSS (.app-
//  sidebar is fixed, .app-content carries the margin), so this wrapper just
//  emits their DOM and lets styles.css do the layout. No manual width offset,
//  no MUI Box — the previous hand-rolled column is what made our shell only
//  approximately match.
// ============================================================================

export function AppShell({
  scope,
  brand,
  sections,
  title,
  breadcrumb,
  actions,
  children,
}: {
  scope: 'platform' | 'organisation' | 'mail';
  brand: string;
  sections: NavSection[];
  title?: string;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="page">
      <Topbar scope={scope} />
      <Sidebar sections={sections} brand={brand} />

      <div className="main-content app-content">
        <div className="container-fluid">
          {(title || breadcrumb || actions) && (
            <div className="page-header-breadcrumb d-flex align-items-center justify-content-between flex-wrap gap-2 my-3">
              <div>
                {title && <h1 className="page-title fw-semibold fs-20 mb-1">{title}</h1>}
                {breadcrumb && (
                  <ol className="breadcrumb mb-0">
                    {breadcrumb.map((b, i) => (
                      <li
                        key={b.label}
                        className={`breadcrumb-item${i === breadcrumb.length - 1 ? ' active' : ''}`}
                        {...(i === breadcrumb.length - 1 ? { 'aria-current': 'page' } : {})}
                      >
                        {b.href ? <a href={b.href}>{b.label}</a> : b.label}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              {actions && <div className="d-flex gap-2 flex-wrap">{actions}</div>}
            </div>
          )}

          {children}
        </div>
      </div>
    </div>
  );
}
