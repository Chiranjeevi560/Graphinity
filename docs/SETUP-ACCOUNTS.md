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
   - **Region:** choose **Singapore** (it may be shown as "Southeast Asia (Singapore)").
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
8. Leave the **access token expiry** at its default of **3600 seconds** (one hour). Graphinity
   refuses longer-lived tokens on purpose.
9. Open **Authentication → Sign In / Providers**, click **Google**, and keep this tab open. It shows
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
4. Open **Data Access** → **Add or remove scopes**. Tick **openid**, **…/auth/userinfo.email** and
   **…/auth/userinfo.profile** (only these three) → **Update** → **Save**. These are basic scopes;
   Google doesn't require a review for them.
5. Open **Clients** → **Create client**:
   - **Application type:** **Web application**
   - **Name:** `Graphinity web`
   - **Authorized JavaScript origins:** add `http://localhost:5173`
   - **Authorized redirect URIs:** paste the **Callback URL** from Supabase (Part A, step 9). It
     looks like `https://abcdefgh.supabase.co/auth/v1/callback`.
   - Click **Create**. A box shows the **Client ID** and **Client secret**. Keep it open.
6. Open **Audience**. While the app is in **Testing**, only people you list can sign in: click
   **Add users** and add your own Gmail address. (Publishing to everyone happens at launch.)

## Part C: Connect Google to Supabase

1. Back in Supabase's **Google** provider page (Part A, step 9):
   - Turn **Enable Sign in with Google** on.
   - Paste the **Client ID** and **Client secret** from Google.
   - Click **Save**.
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

## Part E (optional now, needed before launch): GitHub

So the automatic checks (CI) run on every change:

1. On **github.com**, click **+ → New repository**: name `graphinity`, **Private**, and don't add a
   README, licence or .gitignore (the project has them). Click **Create repository**.
2. Send me the repository's address (like `https://github.com/yourname/graphinity`). I'll connect
   the project; you'll run the one `git push` command yourself so your GitHub login stays yours.
