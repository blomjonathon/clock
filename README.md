# Student Time Clock

A simple clock-in and clock-out app for about 30 students.

- **Students** go to `/`, type their PIN, and press **Clock In / Out**. The app checks their phone's GPS location against the school location. The first punch of the day clocks them in and the next one clocks them out.
- **Admin** goes to `/admin` to:
  - see the weekly timesheet, with hours per student per day and missing clock-outs flagged
  - edit, add, or delete entries (anything an admin changes is marked "edited")
  - export to CSV or print
  - manage students and PINs, and set the school location

## Why it needs a server (not GitHub Pages)

GitHub Pages can only serve static files. It can't store punches from 30 different phones in one place, and it can't enforce the location check. This app is a small Node.js server with a built-in SQLite database. The code can still live on GitHub. You deploy it to a host that runs Node.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
ADMIN_PASSWORD="pick-a-strong-password" npm start
# PowerShell:  $env:ADMIN_PASSWORD="pick-a-strong-password"; npm start
```

Open http://localhost:3000 (students) and http://localhost:3000/admin (admin).

## Environment variables

| Variable          | Purpose                                                                                   | Default   |
|-------------------|-------------------------------------------------------------------------------------------|-----------|
| `ADMIN_PASSWORD`  | **Required.** Password for `/admin`, 12+ characters. The server won't start without it. Changing it signs out every admin session. | none |
| `NODE_ENV`        | Set to `production` when deployed. Login cookies are then only sent over HTTPS.            | none      |
| `TRUST_PROXY`     | Set to `1` on Render, Railway, or behind nginx or Caddy so rate limits see real IPs. **Leave unset if nothing sits in front of the app.** | off |
| `PIN_LENGTH`      | Digits in auto-generated PINs (4–8)                                                       | `6`       |
| `PORT`            | Port to listen on                                                                         | `3000`    |
| `DATA_DIR`        | Folder for `clock.db`. Point it at persistent storage.                                    | `./data`  |

## Security

What the app already does:

- **Admin password:** the server refuses to start with a missing or weak password. The password is compared in constant time and is never stored in the database.
- **Brute-force protection:** 8 wrong admin passwords from one IP locks that IP out for 15 minutes, and every failed and successful login is logged. Wrong student PINs are also rate-limited.
- **Admin sessions:** each login gets a random 256-bit token. Only its hash is stored, and the cookie is `HttpOnly`, `SameSite=Strict` and `Secure` in production. Sessions expire after 8 hours. Sign-out truly revokes the session, and **Sign out everywhere** ends every session.
- **Cross-site request forgery (CSRF):** requests from other sites are rejected by an Origin check, and only JSON is accepted.
- **XSS and clickjacking:** a strict Content Security Policy, `X-Frame-Options: DENY`, `nosniff`, and HSTS over HTTPS. All names and notes are escaped before display.
- **Student phones:** each phone gets a random 256-bit key in an `HttpOnly` cookie that scripts can't read. Only a hash of the key is stored, and setup codes are stored hashed too.
- **PINs:** 6-digit random PINs by default, with easy PINs like `111111` and `123456` skipped. With 30 students, a random guess has about a 1-in-33,000 chance of hitting one.
- **Data:** `clock.db` is outside `public/`, so it can never be downloaded. `data/` and `.env` are in `.gitignore`.

Your part:

1. Use a long, unique admin password, such as a 4-word passphrase. Don't reuse your email password.
2. Set environment variables in the host's dashboard. **Never commit the password to GitHub.**
3. Deploy with HTTPS only, with `NODE_ENV=production` and `TRUST_PROXY=1` (on Render or Railway).
4. Keep the GitHub repo **private** if you can. It isn't required, since no secrets are in the code.
5. Don't stay signed in to admin on a shared or classroom computer. Press **Sign out** when you're done.
6. Run `npm audit` and `npm update` every few months.
7. Back up `clock.db` regularly.

## First-time setup

1. Sign in at `/admin`.
2. **Settings:** stand at school with a phone, open `/admin`, and press **Use my current location**. Then press **Save**. A radius of 150–300 m usually covers a campus.
3. **Students:** paste all the names into **Add many at once**. Each student gets a unique random 6-digit PIN.
4. Press **Print setup slips**. Each student gets a slip with the app address, their PIN, and a one-time **setup code**.
5. Each student opens the address on **their own phone**, enters the setup code and PIN, and that phone is now signed in as them.

## Phone sign-in (how sharing is prevented)

- The clock page does nothing until a phone is set up with a teacher-issued code. A stranger with the link only sees the setup screen.
- Each setup code works **once** and expires after 7 days.
- Each student can clock in from **one** phone only. Setting up a new phone signs out the old one.
- A phone already set up for one student **can't** be set up for a second student, and a PIN only works on its owner's phone.
- 5 wrong PINs on a phone locks it for 10 minutes.
- **New phone or cleared browser data:** in **Students**, press **Setup code** to give them a new one. To sign a phone out right away (lost phone), press **Reset phone**.
- **iPhone tip:** a home-screen shortcut has its own storage, separate from Safari. Students who want to use a home-screen icon should add it *first*, open it, and then do the setup inside it.

## Deploying

The location check only works over **HTTPS**, because browsers block GPS on plain `http://` (except on `localhost`). Any of these hosts provide HTTPS automatically:

- **Railway** or **Render**: connect the GitHub repo. Set the start command to `npm start` and set `ADMIN_PASSWORD`, `NODE_ENV=production`, and `TRUST_PROXY=1`. **Attach a persistent disk or volume** and set `DATA_DIR` to its mount path. Without one, the timesheet data is wiped on every redeploy.
- **A school computer or server**: run `npm start` behind a reverse proxy with HTTPS (for example Caddy).

Back up `clock.db` (in `DATA_DIR`) from time to time.

## How it handles edge cases

- **Forgot to clock out:** that entry stays open and is flagged as missing in the report. The student's next punch starts a new day. The admin fixes the missing time in the report.
- **Double tap:** a clock-out within 60 seconds of clocking in is rejected.
- **Removing a student:** use **Deactivate** to keep their history. **Delete** removes their entries too.

## Limits to know about

The location check uses the location the student's browser reports. That stops casual clock-ins from home. A determined student with a location-spoofing tool could still get around it, as with any web-based geofence. Check the report for odd patterns.
