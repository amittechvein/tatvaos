'use client';

// ============================================================================
//  The signed-in person's avatar, and the account menu behind it
// ============================================================================
//
//  One button for every header that needs to say who is signed in: the
//  console Topbar, and the Docs and Sheets editors, which draw their own
//  header and had no avatar at all until 9 October 2026. Amit, with more than
//  one account signed in on the same Chrome, opened a document and could not
//  tell which account he was using. The only avatars in the editor header were
//  the PRESENCE circles (who else has the document open), which look the same
//  and say nothing about the account. Google puts this button at the far right
//  of the Docs header; so do we.
// ============================================================================

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useSelfPhoto } from '@/components/ui/UserPhoto';
import { AccountMenu } from './AccountMenu';
import { HEADER_LINK } from './Topbar';

export function AccountButton() {
  const { user } = useAuth();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const selfPhoto = useSelfPhoto();

  const initial = (user?.displayName ?? '?').charAt(0).toUpperCase();
  // The address on hover, so "which account am I?" needs no click at all.
  const label = user?.email ? `Account: ${user.email}` : 'Account';

  return (
    <>
      <button type="button" aria-label={label} title={label} className={HEADER_LINK}
              onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        {selfPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={selfPhoto} alt="" width={34} height={34}
               className="h-[34px] w-[34px] rounded-full object-cover" />
        ) : (
          <span className="grid h-[34px] w-[34px] place-items-center rounded-full bg-brand-500 text-sm font-bold text-white">
            {initial}
          </span>
        )}
      </button>

      <AccountMenu anchorEl={anchor} onClose={() => setAnchor(null)} />
    </>
  );
}
