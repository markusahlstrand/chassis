---
"@substrat-run/dashboard": patch
"@substrat-run/oidc-rp": patch
---

Verify an invite is for the signed-in email before accepting it. An existing member — typically the team owner — who opened an invite meant for someone else was silently switched into the team by the server's "already a member" shortcut, never learning the invite wasn't theirs. The accept flow now fetches the invite preview and compares the invited email to the signed-in email first; on a mismatch it shows the "this invite is for X" screen instead of accepting or switching. That screen's "sign out" carries a `returnTo` back to the invite link (`@substrat-run/oidc-rp` `/api/auth/logout` gains same-origin `returnTo`), so after signing out the user re-enters the invite unauthenticated and gets the sign-up screen prefilled with the invited email.
