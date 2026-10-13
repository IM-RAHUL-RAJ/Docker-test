# 🚀 RDS Explorer — Setup & Run Guide

A quick guide to getting the **RDS Explorer** dashboard running in Docker and connected to the PostgreSQL database on Amazon RDS.

> **No code changes are required.** The only thing you add is a `.env` file with the database connection details.

---

## 📋 Contents

1. [What you get](#-what-you-get)
2. [The one change: `.env`](#-the-one-change-env)
3. [Run it from scratch](#-run-it-from-scratch)
4. [Verify it works](#-verify-it-works)
5. [Day-to-day commands](#-day-to-day-commands)
6. [Applying changes](#-applying-changes)
7. [Troubleshooting](#-troubleshooting)

---

## ✨ What you get

A read-only web dashboard on port **5000** that shows every schema and table in the database, with row counts, table structure and paged data.

| Schema | Tables | Names (rows) |
|---|:---:|---|
| `auth` | 4 | `users` (5), `user_roles` (0), `refresh_tokens` (0), `kyc` (0) |
| `public` | 0 | — |
| `trading` | 9 | `watchlist` (6), `users` (5), `instruments` (8), `order_history` (18), `positions` (7), `holdings` (7), `watchlist_inst` (20), `orders` (10), `trading_accounts` (5) |

*Snapshot taken on 2026-10-13. The dashboard always shows live values.*

---

## 🔧 The one change: `.env`

Create a file named `.env` in the project folder (`~/Docker-test/.env`):

```ini
DB_ENGINE=postgresql
DB_HOST=database-1.c562y46ccn9y.ap-south-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres
DB_PASSWORD=<your-db-password>
```

| Variable | Meaning |
|---|---|
| `DB_ENGINE` | `postgresql` or `mysql` |
| `DB_HOST` | The RDS endpoint (no `https://`, no port) |
| `DB_PORT` | `5432` for PostgreSQL |
| `DB_NAME` | The database name, not the RDS instance identifier |
| `DB_USER` | Database user |
| `DB_PASSWORD` | That user's password |

> 🔒 `.env` is listed in `.gitignore` and `.dockerignore`, so it is never committed or baked into the image. The password is deliberately left as a placeholder in this guide — keep it out of any file that gets pushed to GitHub.

---

## ▶️ Run it from scratch

### Step 1 — Get the code

```bash
cd ~
git clone https://github.com/IM-RAHUL-RAJ/Docker-test.git
cd Docker-test
```

### Step 2 — Create the `.env` file

```bash
cp .env.example .env
nano .env          # fill in the values from the section above
chmod 600 .env     # only your user can read it
```

### Step 3 — Build the image

```bash
sudo docker build -t rds-explorer .
```

### Step 4 — Run the container

```bash
sudo docker run -d \
  --name rds-explorer \
  --env-file .env \
  -p 5000:5000 \
  --restart unless-stopped \
  rds-explorer
```

| Flag | Meaning |
|---|---|
| `-d` | Run in the background |
| `--name rds-explorer` | A friendly name for the container |
| `--env-file .env` | Pass the database settings in as environment variables |
| `-p 5000:5000` | Host port 5000 → container port 5000 |
| `--restart unless-stopped` | Start again automatically after a reboot |

---

## ✅ Verify it works

```bash
sudo docker ps                    # container should be "Up"
curl localhost:5000/health        # {"status":"ok"}
```

Then open the dashboard in your browser:

```
http://<EC2-PUBLIC-IP>:5000
```

Currently: **http://13.126.220.195:5000**

---

## 🛠 Day-to-day commands

| Task | Command |
|---|---|
| See running containers | `sudo docker ps` |
| Follow the logs | `sudo docker logs -f rds-explorer` |
| Stop | `sudo docker stop rds-explorer` |
| Start again | `sudo docker start rds-explorer` |
| Restart | `sudo docker restart rds-explorer` |
| Remove the container | `sudo docker rm -f rds-explorer` |

> 💡 To drop the `sudo`, run `sudo usermod -aG docker $USER`, then log out and back in.

---

## 🔄 Applying changes

**Changed `.env`** — recreate the container (no rebuild needed):

```bash
sudo docker rm -f rds-explorer
sudo docker run -d --name rds-explorer --env-file .env -p 5000:5000 --restart unless-stopped rds-explorer
```

**Changed the code** (for example after `git pull`) — rebuild, then recreate:

```bash
git pull
sudo docker build -t rds-explorer .
sudo docker rm -f rds-explorer
sudo docker run -d --name rds-explorer --env-file .env -p 5000:5000 --restart unless-stopped rds-explorer
```

---

## 🩺 Troubleshooting

Start with the health endpoint — it explains the failure in plain English:

```bash
curl localhost:5000/health
sudo docker logs --tail 50 rds-explorer
```

| Symptom | Likely cause | Fix |
|---|---|---|
| `permission denied ... docker.sock` | Your user isn't in the `docker` group | Use `sudo`, or add yourself to the group |
| `container name "/rds-explorer" is already in use` | An old container still exists | `sudo docker rm -f rds-explorer`, then run again |
| `port is already allocated` | Something else is using port 5000 | Stop it, or map another port: `-p 8080:5000` |
| Health says *can't reach the database host* | Wrong `DB_HOST` / `DB_PORT`, or the network blocks it | Check the values in `.env` |
| Health says *Wrong DB_USER or DB_PASSWORD* | Bad credentials | Fix `.env` and recreate the container |
| Health says *DB_NAME doesn't exist* | Wrong database name | Use the database name (`postgres`) |
| Page loads locally but not in the browser | Port 5000 isn't reachable from your machine | Check the network access to the instance |

---

## 📎 Good to know

- **Read-only:** the app only runs `SELECT` statements.
- **No login:** anyone who can reach port 5000 can read every table, so keep access restricted.
- **`seed.py`:** loads demo data into new `sales` and `hr` schemas. It writes to the database, so only run it if you want sample data.
