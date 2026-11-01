# kiasellskc.com: one-time setup

One free site on GitHub Pages:
- **kiasellskc.com**: Kia's public landing page. The contact form there creates a lead in Lofty tagged **Website Lead** and emails Kia.
- **kiasellskc.com/crm**: Kia's CRM, with its own login. Lofty stays the main record. Every call, text, email, note and follow-up Kia logs here is saved straight into Lofty. Emails go out from Kia's Gmail, and follow-ups and showings can go on her Google Calendar.

Behind both is a small Google Apps Script "server" in Kia's Google account. It holds the Lofty API key, so the key never appears on the website.

## 1. Website (GitHub)
1. On github.com, signed in as **jrobinson2226-hub**, click **New repository**. Name it `kiasellskc-site`, choose **Public**, and click **Create**. (Don't add a README.)
2. Tell Claude it's created. Claude uploads the site.
3. In the repo, open **Settings > Pages**. Under Source, choose **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.

## 2. Server (in Kia's Google account)
1. Sign in to Google as **kiasellskc@gmail.com** and go to **script.google.com**. Click **New project** and rename it "Kia's CRM server."
2. Delete what's in `Code.gs`, paste in all of `server-code.gs`, and click **Save**.
3. Click the gear (**Project Settings**). Under **Script properties**, click **Add script property**:
   - Property: `LOFTY_API_KEY`
   - Value: the Lofty API key (from Lofty, **Settings > Integrations > API**).

   Click **Save**. Don't paste the key anywhere else, including chat.
4. Back in the editor, choose **testLofty** in the function menu and click **Run**.
   - The first time, Google asks for permission. Choose Kia's account, then **Advanced > Go to Kia's CRM server (unsafe)**, then **Allow**. It says "unsafe" only because the script is Kia's own and hasn't been reviewed by Google.
   - The log should say "Connected to Lofty as Kia Robinson… Contacts: 730" or similar.
5. Choose **setupLogins** and click **Run**. The log shows two invite links, one for Kia and one for Jason. Save them; they work for 14 days.
6. Click **Deploy > New deployment**. Under Select type (the gear), choose **Web app**, then set:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
7. Send that URL to Claude. Claude adds it to `config.js`, which turns on the contact form and the CRM.

## 3. Point kiasellskc.com at the new site (GoDaddy)
Do this last. The old GoDaddy page stays up until you switch.
1. In GoDaddy, open **My Products**. If the Website Builder (Airo) site is connected to kiasellskc.com, disconnect it or cancel it. Keep the **domain**.
2. Open **kiasellskc.com > DNS**.
   - Delete any existing **A** record with Name **@**, such as the one that points to the GoDaddy builder.
   - Add four **A** records, each with Name **@**:
     - 185.199.108.153
     - 185.199.109.153
     - 185.199.110.153
     - 185.199.111.153
   - Edit the **www** record so it's a **CNAME** pointing to **jrobinson2226-hub.github.io**.
   - Leave **MX** records (email) alone.
3. Back in GitHub, open **Settings > Pages**. Type `kiasellskc.com` under **Custom domain** and click **Save**. When the check turns green, tick **Enforce HTTPS**. DNS can take up to an hour, and HTTPS can take up to a day.

## 4. Sign in to the CRM
1. Kia opens her invite link and chooses a password (10+ characters). Jason does the same with his.
2. **iPhone:** open kiasellskc.com/crm in Safari, then **Share > Add to Home Screen**.
3. **Computer:** bookmark kiasellskc.com/crm.

## Good to know
- **Website leads** land in Lofty tagged **Website Lead** (plus **Seller** if they picked selling), with their message saved as a pinned note. Kia gets an email titled "New website lead: Name" with a link that opens them in the CRM. Replying to that email goes straight to the person.
- Spam protection: a hidden field that catches bots, one submission per person every 10 minutes, and a cap of 30 an hour.
- The CRM's contact list comes straight from Lofty and refreshes every few minutes while it's open. The ↻ button pulls the latest right away.
- **Calls and texts** use Kia's own phone. Tapping **Call** dials, and she taps **Log call** when she's done. Tapping **Text** opens Messages with the text ready and logs it in Lofty.
- **Email** sends from kiasellskc@gmail.com (about 100 a day on a regular Gmail account) and logs each one in Lofty.
- **Server changes:** paste the new code, then use **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**, so the web address stays the same.
- Search engines are told to skip /crm. The landing page is open to search.
- **Listings** on the homepage come from Kia's Lofty account (Heartland MLS) and refresh about once an hour. Active listings show full details. Sold homes show only the photo, neighborhood and sold date, never the price. New listings and sales appear on their own.
