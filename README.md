# RDS Explorer 🔷

A Flask web app that connects to an **Amazon RDS** database (PostgreSQL or MySQL) and shows:

- every **schema** and **table** (with row counts) in a sidebar
- a **3D skyline** of the whole database — one glowing tower per table, height = rows
- each table's **data**, page by page, and its **structure** (columns, types, PK, FKs, indexes)
- a **3D bar chart** per table — pick a label column and a value column (SUM or COUNT)

It is **read-only**: the app only runs `SELECT` statements.

---

## 1. Project layout

```
rds-explorer/
├── app.py                  # Flask app: DB connection + JSON API
├── templates/index.html    # page layout
├── static/css/style.css    # styling
├── static/js/app.js        # UI logic + 3D scene (Three.js)
├── requirements.txt        # Python packages
├── Dockerfile              # how to build the image
├── .dockerignore           # files NOT copied into the image
├── .env.example            # template for your DB settings
└── README.md
```

### How the pieces talk

```
Browser (index.html + app.js + Three.js)
        │  fetch /api/...
        ▼
Flask (app.py)  ──SQLAlchemy──▶  Amazon RDS (PostgreSQL / MySQL)
```

| Endpoint | What it returns |
|---|---|
| `GET /` | The UI |
| `GET /health` | `{"status":"ok"}` if the DB is reachable |
| `GET /api/overview` | All schemas → tables → row & column counts |
| `GET /api/schemas/<schema>/tables/<table>` | Columns, PK, FKs, indexes |
| `GET /api/schemas/<schema>/tables/<table>/rows?page=1&size=50` | One page of data |

---

## 2. Before you start (AWS side)

You need the following ready **once**:

### 2.1 Get the RDS endpoint
AWS Console → **RDS** → **Databases** → click your DB → **Connectivity & security** → copy the **Endpoint**
(looks like `mydb.abc123xyz.ap-south-1.rds.amazonaws.com`) and note the **Port** (5432 Postgres / 3306 MySQL).

### 2.2 Allow the EC2 instance to reach RDS
RDS → your DB → **VPC security groups** → **Inbound rules** → add:

| Type | Port | Source |
|---|---|---|
| PostgreSQL (or MySQL/Aurora) | 5432 (or 3306) | **the security group of your EC2 instance** |

Test it from the EC2 box:
```bash
nc -zv <RDS-ENDPOINT> 5432        # should say "succeeded" / "open"
```

### 2.3 Open the app's port on EC2
EC2 → your instance → **Security** → security group → **Inbound rules** → add:

| Type | Port | Source |
|---|---|---|
| Custom TCP | 5000 | **My IP** (don't use 0.0.0.0/0 — the app has no login) |

### 2.4 (Recommended) Create a read-only DB user
The app only reads, so give it a user that *can* only read.

**PostgreSQL** (connect with `psql -h <endpoint> -U <admin> -d <db>`):
```sql
CREATE USER explorer WITH PASSWORD 'StrongPassword123!';
GRANT CONNECT ON DATABASE mydatabase TO explorer;
-- repeat these two lines for every schema you want to see:
GRANT USAGE ON SCHEMA public TO explorer;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO explorer;
```

**MySQL**:
```sql
CREATE USER 'explorer'@'%' IDENTIFIED BY 'StrongPassword123!';
GRANT SELECT, SHOW VIEW ON mydatabase.* TO 'explorer'@'%';
```

> **MySQL note:** in MySQL a "schema" is the same thing as a "database". The sidebar will show
> every database the user can see.

---

## 3. Get the code onto EC2

SSH into your instance, then either `git clone` your repo or copy the folder up:

```bash
# from your laptop
scp -i my-key.pem -r rds-explorer ec2-user@<EC2-PUBLIC-IP>:~/
ssh -i my-key.pem ec2-user@<EC2-PUBLIC-IP>
cd ~/rds-explorer
```

---

## 4. Configure the connection

```bash
cp .env.example .env
nano .env          # fill in your values
```

```ini
DB_ENGINE=postgresql          # or mysql
DB_HOST=mydb.abc123xyz.ap-south-1.rds.amazonaws.com
DB_PORT=5432                  # 3306 for mysql
DB_NAME=mydatabase
DB_USER=explorer
DB_PASSWORD=StrongPassword123!
```

> 🔒 `.env` holds your password. It is listed in `.gitignore` and `.dockerignore`, so it is never
> committed or baked into the image. You pass it in at run time instead.

---

## 5. Run it with Docker (main path)

### 5.1 Install Docker on EC2 (one time)

**Amazon Linux 2023**
```bash
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
exit   # log out and SSH back in so the group change applies
```

**Ubuntu**
```bash
sudo apt-get update && sudo apt-get install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
exit   # log out and SSH back in
```

Check: `docker --version`

### 5.2 Build the image
```bash
cd ~/rds-explorer
docker build -t rds-explorer .
```
`-t rds-explorer` gives the image a name. The `.` means "use the Dockerfile in this folder".

### 5.3 Run the container
```bash
docker run -d \
  --name rds-explorer \
  --env-file .env \
  -p 5000:5000 \
  --restart unless-stopped \
  rds-explorer
```

| Flag | Meaning |
|---|---|
| `-d` | run in the background |
| `--name rds-explorer` | a friendly name for the container |
| `--env-file .env` | pass your DB settings in as environment variables |
| `-p 5000:5000` | EC2 port 5000 → container port 5000 |
| `--restart unless-stopped` | come back up after a reboot |

### 5.4 Check it works
```bash
docker ps                          # container should be "Up"
curl localhost:5000/health         # {"status":"ok"}
docker logs -f rds-explorer        # live logs (Ctrl+C to stop following)
```

### 5.5 Open the UI
In your browser: **`http://<EC2-PUBLIC-IP>:5000`**

### 5.6 Everyday commands
```bash
docker stop rds-explorer           # stop
docker start rds-explorer          # start again
docker rm -f rds-explorer          # delete the container

# after changing the code: rebuild and re-run
docker rm -f rds-explorer
docker build -t rds-explorer .
docker run -d --name rds-explorer --env-file .env -p 5000:5000 --restart unless-stopped rds-explorer
```

---

## 6. Run it without Docker (for development)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
FLASK_DEBUG=1 python app.py        # reads .env automatically
```
Open `http://<EC2-PUBLIC-IP>:5000`. Debug mode reloads the server when you edit code.

---

## 7. The Dockerfile, line by line

```dockerfile
FROM python:3.12-slim                 # small official Python base image
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1                # no .pyc files; logs appear immediately
WORKDIR /app                          # all following commands run in /app
COPY requirements.txt .               # copy ONLY requirements first...
RUN pip install --no-cache-dir -r requirements.txt   # ...so this layer is cached
COPY . .                              # then copy the code (changes often)
RUN useradd --create-home appuser
USER appuser                          # don't run as root
EXPOSE 5000                           # documents the port
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--timeout", "60", "app:app"]
```

Two ideas worth remembering:
- **Layer caching** — copying `requirements.txt` before the code means editing `app.py` doesn't re-install every package on each build.
- **gunicorn vs `python app.py`** — Flask's built-in server is for development only; gunicorn is a production server. `app:app` means "the `app` object in `app.py`".

---

## 8. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| UI shows *"could not connect / timeout expired"* | RDS security group doesn't allow the EC2 security group on 5432/3306 (step 2.2). Test with `nc -zv`. |
| *"password authentication failed"* / *"Access denied"* | Wrong `DB_USER`/`DB_PASSWORD` in `.env`. Re-run the container after fixing. |
| *"database … does not exist"* | `DB_NAME` must be the database name, not the instance identifier. |
| Browser can't reach `:5000` at all | EC2 security group missing port 5000 (step 2.3), or container not running (`docker ps`). |
| Tables show **—** for rows | The DB user lacks `SELECT` on that table — grant it (step 2.4). |
| Page loads but the 3D area is empty | The browser needs internet to load Three.js and fonts from the CDN; check the browser console. |
| `docker: permission denied` | You skipped logging out after `usermod -aG docker` (step 5.1). |
| Changed `.env` but nothing changed | Env vars are read at start-up: `docker rm -f rds-explorer` and `docker run …` again. |

---

## 9. Security notes

- The app has **no login**. Keep port 5000 restricted to your IP, or put it behind a VPN / load balancer with auth.
- Use the **read-only** DB user from step 2.4.
- Never commit `.env` and never `COPY` it into an image — always `--env-file` at run time.
- Table and schema names from the URL are checked against the real list from the database before
  any query is built, and values are never pasted into SQL — so the API can't be used for SQL injection.

---

## 10. Ideas to extend it (good exercises)

1. Add a search box that filters rows (`WHERE column ILIKE :term`).
2. Export the current page as CSV (`/api/.../rows.csv`).
3. Draw foreign keys as glowing lines between towers in the 3D skyline.
4. Push the image to **Amazon ECR** and run it on **ECS Fargate** instead of a single EC2 box.
5. Read DB credentials from **AWS Secrets Manager** instead of `.env`.
