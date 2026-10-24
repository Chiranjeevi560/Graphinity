# Setting up the accounts

Everything here is free, and none of it needs a payment card. **If any screen asks for a card,
stop and tell me.**

Screens change over time. If something below doesn't match what you see, take a screenshot and
show me rather than guessing.

You'll end with **two values that are safe to share** with me in chat, and **one secret** that you
paste into a file yourself and never share.

---

## Part A: Supabase (sign-in and, later, the database)

1. Go to **supabase.com** and click **Start your project**. Sign up with your GitHub or email.
2. When asked to create an **organization**, give it any name (for example "Graphinity") and
   choose the **Free** plan.
3. Click **New project**:
   - **Name:** `graphinity`
   - **Database password:** click **Generate a password**, then save it in your password manager.
     We need it at deploy time. Don't send it to me.
   - **Region:** under Asia-Pacific, click **Need a specific region?** and choose **Singapore**.
   - **GitHub (optional):** skip it. It lets Supabase change your database when code is pushed;
     we apply database changes ourselves, one tested step at a time.
   - **Security:** turn **Enable Data API** **off** (all data goes through our own server). The
     **Automatically expose new tables** switch then greys out; that's expected and safe. Turn
     **Enable automatic RLS** **on**.
   - Click **Create new project** and wait about two minutes.
4. **Check the token signing keys.** In the left sidebar open **Project Settings**, then the page
   about **JWT keys** / **JWT signing keys**.
   - If the current key type is **ECC (P-256)** or **RSA**, you're done with this step.
   - If it says the **Legacy JWT secret** is in use, click **Migrate JWT secret**, then
     **Rotate keys**. Graphinity refuses tokens signed with the old shared secret, so sign-in won't
     work until this is done.
5. **Find your two public values.** In **Project Settings → API Keys**:
   - Copy the **publishable key** (starts with `sb_publishable_`). If there isn't one, click to
     create publishable and secret keys first.
   - Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`). It's on the project's
     home page or under **Project Settings → Data API**.
6. **Find the secret key** on the same API Keys page: the **secret key** starts with `sb_secret_`.
   **Don't copy it into chat.** You'll paste it into a file in Part D.
7. **Allow sign-ins to return to your computer.** Open **Authentication → URL Configuration**:
   - **Site URL:** `http://localhost:5173`
   - Under **Redirect URLs** click **Add URL** and add exactly: `http://localhost:5173/auth/callback**`
     (the two stars let the safety code in the address through).
   - Click **Save**.
8. **Turn off email sign-in.** **Authentication → Sign In / Providers → Email**: switch
   **Enable Email provider** off and save. The publishable key is public, so with email on, anyone
   could create an email account and get a valid token. Graphinity is Google-only.
9. Leave the **access token expiry** at its default of **3600 seconds** (one hour). Graphinity
   refuses longer-lived tokens on purpose.
10. Open **Authentication → Sign In / Providers**, click **Google**, and keep this tab open. It shows
   a **Callback URL** you need in Part B.

## Part B: Google (the "Continue with Google" screen)

1. Go to **console.cloud.google.com** and sign in with the Google account that should own the app.
   If asked, accept the terms. Google Cloud may offer a free trial with a card: **skip it**. Sign-in
   doesn't need billing.
2. At the top, click the project picker → **New project** → name it `graphinity` → **Create**. Make
   sure it's selected afterwards.
3. In the search bar type **Google Auth Platform** and open it. Click **Get started**:
   - **App name:** `Graphinity`
   - **User support email:** your email
   - **Audience:** **External**
   - **Contact email:** your email
   - Agree to the policy, then **Create**.
4. Open **Data Access** → **Add or remove scopes**. Tick **openid** and **…/auth/userinfo.email**
   (only these two; never the profile, Cloud or BigQuery rows) → **Update**, then click **Save** on
   the page itself. These are two separate clicks, and forgetting the second one is easy: reload the
   page and check both scopes are still listed under "non-sensitive scopes". These are basic scopes;
   Google doesn't require a review for them.
5. Open **Clients** → **Create client**:
   - **Application type:** **Web application**
   - **Name:** `Graphinity web`
   - **Authorized JavaScript origins:** add `http://localhost:5173`
   - **Authorized redirect URIs:** paste the **Callback URL** from Supabase (Part A, step 10). It
     looks like `https://abcdefgh.supabase.co/auth/v1/callback`.
   - Click **Create**. A box shows the **Client ID** and **Client secret**. Copy the secret now:
     Google may not show it again. If you lose it, open the client and use **Add secret**.
6. Open **Audience**. While the app is in **Testing**, only people you list can sign in: click
   **Add users** and add your own Gmail address. (Publishing to everyone happens at launch.)

## Part C: Connect Google to Supabase

1. Back in Supabase's **Google** provider page (Part A, step 10):
   - Turn **Enable Sign in with Google** on.
   - Paste the **Client ID** and **Client secret** from Google.
   - Click **Save** and wait for the confirmation. Nothing is saved until then. (On the first
     attempt the form was filled in but never saved, and sign-in stayed off.)
2. You can close Google's box now. If you ever lose the client secret, create a new one in Google
   and paste it here again.

## Part D: Let your computer use the real accounts

1. **Send me in chat:** the **Project URL** and the **publishable key**. Both are public by design.
   They'll be in the website anyway. I'll put them in a file the website reads.
2. **Paste the secret key yourself.** In Terminal, in the project folder:

   ```bash
   open -e .local/api.env
   ```

   It opens in TextEdit. Change these two lines (leave the others alone), then save and close:

   ```
   SUPABASE_URL=https://abcdefgh.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_…your secret key…
   ```

   This file is private: git ignores it and only your Mac user can read it.
3. Tell me when that's done. I'll start the website and server, and you'll sign in with your real
   Google account on your own screen. That first real sign-in, and deleting a test account
   afterwards, are the checks the local stand-in can't make.

## Checking it worked (what we did, and how you can repeat it)

Without printing any secret, you can confirm each part from the project folder. Use Node, not the
system Python: that Python has no root certificates on this Mac.

- Google is on and email is off: ask `https://<project>.supabase.co/auth/v1/settings` with the
  publishable key in an `apikey` header: `external.google` must be `true`, `external.email` `false`.
- The secret key is accepted: `GET /auth/v1/admin/users?per_page=1` with it in `apikey` gives 200;
  a made-up key gives 401.
- Then sign in on your own screen at http://localhost:5173 after starting the API and
  `npm --workspace apps/web run dev -- --mode supabase`. While Google is in Testing, "Google hasn't
  verified this app" is expected: choose Continue and check it only asks for your email address.
- Finally delete the test account from your profile page, and confirm Supabase lists 0 users.

First real run (2026-10-18): sign-in, profile creation and account deletion all worked; Supabase
showed one Google-only user, then none; the server log held no emails or ids.

## Part E (optional now, needed before launch): GitHub

So the automatic checks (CI) run on every change:

1. On **github.com**, click **+ → New repository**: name `graphinity`, **Private**, and don't add a
   README, licence or .gitignore (the project has them). Click **Create repository**.
2. Send me the repository's address (like `https://github.com/yourname/graphinity`). I'll connect
   the project; you'll run the one `git push` command yourself so your GitHub login stays yours.

## Part F: Make Google's screen name Graphinity's site, not Supabase

Google's sign-in screen names the address it returns to. It used to return to Supabase, so it said
"Sign in to cfwzkjpqpmttqbbnnzch.supabase.co". The website now asks Google to come straight back to
Graphinity, so the screen names our own site, and it asks only for your email address (no name, no
photo). Supabase's own fix, a custom domain, is a paid add-on, so we don't use it.

1. Open **console.cloud.google.com**, check the project picker at the top says **graphinity**.
2. Search **Google Auth Platform** → open it → **Clients** → click **Graphinity web**.
3. Under **Authorized JavaScript origins**, make sure both are there (click **Add URI** for any
   missing one): `http://localhost:5173` and `http://localhost:4173`.
4. Under **Authorized redirect URIs**, click **Add URI** and add exactly:
   `http://localhost:5173/auth/callback`
   Leave the Supabase address that's already there for now; we remove it once the new sign-in has
   worked for you.
5. Click **Save** at the bottom. Google says changes can take a few minutes to apply.
6. Still in Google Auth Platform, open **Data Access**. If **…/auth/userinfo.profile** is listed,
   click the bin icon next to it, then **Save**. Keep **openid** and **…/auth/userinfo.email**.
7. While you're on **Clients → Graphinity web**, copy the **Client ID** (it ends in
   `.apps.googleusercontent.com`; it's public by design, the secret is separate and stays in
   Supabase). In Terminal, in the project folder:

   ```bash
   open -e apps/web/.env.supabase
   ```

   Add this line at the end, with your Client ID, then save and close:

   ```
   VITE_GOOGLE_CLIENT_ID=paste-it-here.apps.googleusercontent.com
   ```

8. In Supabase: **Authentication → Sign In / Providers → Google**. Check the **Client ID** field
   holds the same Client ID. If there's a switch called **Skip nonce checks**, leave it **off**: the
   nonce is what makes a stolen sign-in useless. Click **Save** only if you changed something.
9. Tell me when that's done, and I'll start everything for you to sign in on your own screen. On
   your computer the screen will name `localhost`; once the site is online it will name the site's
   address. Showing the name "Graphinity" with a logo needs Google's brand verification, which we
   do at launch with the final address.

## Part G: Make yourself a moderator (after the database is updated)

Moderators see reports and can keep or remove posts and block people. Only you can add one, from the
Supabase dashboard; the website can't.

1. Open **supabase.com**, your project, then **SQL Editor** in the left bar, then **New query**.
2. First, a check that tells me how your project's main database role is set up (it decides how the
   hiding of reported posts works). Paste this and click **Run**:

   ```sql
   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'postgres';
   ```

   Send me the one row it shows (three words: the name and two true/false values). It holds no
   secret.
3. Then, with your own name on Graphinity in place of `yourname` (without the @), paste and **Run**:

   ```sql
   INSERT INTO app.moderators (profile_id) SELECT id FROM app.profiles WHERE handle = 'yourname';
   ```

   It should say "Success. 1 row". If it says 0 rows, the name is spelled differently; check it on
   your profile page.
4. Reload Graphinity: your profile now has **Review reports**.

To remove a moderator later: `DELETE FROM app.moderators WHERE profile_id = (SELECT id FROM app.profiles WHERE handle = 'theirname');`


## Part H: Search by meaning (Supabase only, free)

Graphinity finds questions asked in other words ("import tax" for "customs duty") with its own model,
trained every day on the posts of people who allowed it, and run on Graphinity's own server. No
outside AI is used, and there is no AI account or token to set up. Until the model has learned
enough to beat matching by words (its quality gate decides, ADR 0010), search works by words.

**Once: turn on the vector extension (it stores the meanings).**
1. Open **supabase.com**, your project, then **Database** in the left bar, then **Extensions**.
2. Search for **vector**. Switch it on. If it asks for a schema, choose **extensions**.
3. Then update the database (Part I). If you skipped step 2, it stops with a message saying to turn
   the extension on first; nothing is changed.

If Render's settings still have `CF_ACCOUNT_ID` or `CF_AI_TOKEN` from before, delete them
(your service, **Environment**): nothing reads them any more. Then revoke that token in Cloudflare
(**My Profile**, **API Tokens**).

## Part I: Update the live database

Changes to the database are numbered files (`db/migrations`), applied by one command that keeps a
record of what ran. This replaces pasting the schema into the SQL Editor. Until the deploy pipeline
does it for you (a later phase), you run it from your computer when a release needs it.

**Once: give your computer the database's main connection.**
1. Open **supabase.com**, your project, and click **Connect** at the top of the page.
2. Choose the **Session pooler** connection string (it works on every network). Copy it. It
   contains `[YOUR-PASSWORD]`: that is the database password from when you made the project. If
   you don't have it, **Project Settings**, **Database**, **Reset database password** (this logs
   out nothing that uses the API's own login).
3. In Terminal, in the Graphinity folder:

   ```bash
   touch .local/migrate.env && chmod 600 .local/migrate.env && open -e .local/migrate.env
   ```

4. In the window that opens, type `MIGRATION_DATABASE_URL=`, paste the string right after it, put
   your password in place of `[YOUR-PASSWORD]`, and save. Don't send it to me: it can change
   anything in the database. The folder is never uploaded to GitHub.

**Each time:** run `npm run db:migrate:remote`. The first time it says `applied
0001_baseline.sql` (your database adopts the record; nothing in it changes) and `schema version
16`. After that it lists any new files it applied, or says `already up to date`.

