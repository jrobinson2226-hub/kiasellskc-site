# Kia's CRM: one-time setup

Kia's CRM is a website at crm.kiasellskc.com with its own login. Lofty stays the main record. Every call, text, email, note and follow-up Kia logs in the app is saved straight into Lofty. Emails go out from Kia's Gmail, and follow-ups and showings can go on her Google Calendar.

There are two parts:
- **The website:** free hosting on GitHub Pages.
- **The server:** a Google Apps Script in Kia's Google account. It holds the Lofty API key, so the key never sits in the website.

## 1. Website (GitHub)
1. On github.com, signed in as jrobinson2226-hub: **New repository**. Name it `kia-crm`, choose **Public**, and click **Create**.
2. Tell Claude it's created, and Claude uploads the app's files.
3. In the repo, go to **Settings > Pages**. Under Source, choose **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.
4. Point Kia's domain at it. Where kiasellskc.com is registered (GoDaddy, for example), open **DNS** and add a record:
   - Type: **CNAME**
   - Name/Host: **crm**
   - Value/Points to: **jrobinson2226-hub.github.io**
5. Back in **Settings > Pages**, type `crm.kiasellskc.com` under **Custom domain** and click **Save**. Once the check turns green (DNS can take up to an hour), tick **Enforce HTTPS**.
6. The app is live at `https://crm.kiasellskc.com`.

## 2. Server (in Kia's Google account)
1. Sign in to Google as **kiasellskc@gmail.com** and go to **script.google.com**. Click **New project**, then rename it "Kia's CRM server."
2. Delete what's in `Code.gs`, paste in all of `setup/server-code.gs`, and click **Save**.
3. Click the gear (**Project Settings**). Under **Script properties**, click **Add script property**:
   - Property: `LOFTY_API_KEY`
   - Value: the API key from Lofty (**Settings > Integrations > API**). Give the key View, Add and Edit on leads, notes, tasks and communication.

   Click **Save**. Don't paste the key anywhere else.
4. Back in the editor, pick **testLofty** in the function menu and click **Run**.
   - Google asks for permission the first time. Choose Kia's account, then **Advanced > Go to Kia's CRM server**, then **Allow**.
   - The log should say "Connected to Lofty as Kia Robinson… Contacts: 730".
5. Pick **setupLogins** and click **Run**. The log shows two invite links, one for Kia and one for Jason. Keep them; they work for 14 days.
6. Click **Deploy > New deployment**. Under Select type (the gear), choose **Web app**, then set:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy**, then copy the **Web app URL**, which ends in `/exec`.
7. Send that URL to Claude, and Claude puts it into `config.js`.

## 3. Sign in
1. Kia opens her invite link and chooses a password (10+ characters). Jason does the same with his.
2. **iPhone:** open the site in Safari, then **Share > Add to Home Screen**.
3. **Computer:** bookmark the site.

## Good to know
- The contact list comes straight from Lofty and refreshes every few minutes while the app is open. The ↻ button pulls the latest right away.
- **Calls and texts** use Kia's own phone. Tapping **Call** dials, and she taps **Log call** when she's done. Tapping **Text** opens Messages with the text ready, and logs it in Lofty.
- **Email** sends from kiasellskc@gmail.com, which allows up to about 100 a day on a regular Gmail account, and logs each one in Lofty.
- **Server changes:** paste the new code, then use **Deploy > Manage deployments > Edit > New version** so the web address stays the same.
