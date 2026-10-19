import { useState } from 'react';
import { Button, LinkButton } from '../components/Button.tsx';
import { Dialog } from '../components/Dialog.tsx';
import { Avatar, CountryBadge, FieldTags, Handle, joinedLabel } from '../components/Identity.tsx';
import { Notifications } from '../components/Notifications.tsx';
import { Standing, useStanding } from '../components/Standing.tsx';
import { turnPushOff } from '../lib/push.ts';
import { ApiError } from '../lib/api.ts';
import { drafts } from '../lib/drafts.ts';
import { navigate } from '../lib/router.ts';
import { api, auth, type Profile } from '../session.tsx';

export default function Me({ profile }: { profile: Profile }) {
  const standing = useStanding(profile.handle);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function deleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      // This browser's subscription goes with the account (the server's rows cascade).
      await turnPushOff(api).catch(() => {});
      await api('/me', { method: 'DELETE', signedIn: true, body: { confirm: true } });
      auth.clear();
      drafts.clear();
      navigate('/goodbye', { replace: true });
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Something went wrong. Try again in a minute.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="page profile">
      <header className="profile-head">
        <Avatar handle={profile.handle} size="large" />
        <div className="profile-names">
          <h1 className="text-title1"><Handle handle={profile.handle} /></h1>
          <div className="profile-meta">
            <CountryBadge country={profile.country} />
            <span className="text-subhead secondary">{joinedLabel(profile.joined)}</span>
          </div>
        </div>
      </header>

      <section className="profile-section">
        <h2 className="text-headline">Knows about</h2>
        <FieldTags fields={profile.fields} />
      </section>

      {standing && <Standing standing={standing} />}

      <Notifications />

      {profile.blocked && (
        <p className="text-subhead hidden-note" role="note">Your account can’t post right now. You can still read, and delete your account.</p>
      )}

      <LinkButton to="/me/edit" variant="secondary" className="btn-block">Edit profile</LinkButton>
      {profile.moderator && <LinkButton to="/review" variant="secondary" className="btn-block">Review reports</LinkButton>}

      <section className="profile-footer">
        <button type="button" className="btn btn-plain" onClick={() => { void turnPushOff(api).catch(() => {}).then(() => auth.signOut()).then(() => { drafts.clear(); navigate('/', { replace: true }); }); }}>
          Sign out
        </button>
        <button type="button" className="btn btn-plain danger" onClick={() => { setConfirming(true); }}>Delete account…</button>
      </section>

      <Dialog
        open={confirming}
        onClose={() => { if (!deleting) setConfirming(false); }}
        title="Delete your account?"
        actions={
          <>
            <Button variant="secondary" onClick={() => { setConfirming(false); }} disabled={deleting}>Cancel</Button>
            <Button className="btn-destructive" onClick={() => { void deleteAccount(); }} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete account'}
            </Button>
          </>
        }
      >
        <p>This permanently deletes your profile and everything you’ve shared. It can’t be undone.</p>
        {deleteError && <p className="form-note tone-bad" role="alert">{deleteError}</p>}
      </Dialog>
    </main>
  );
}
