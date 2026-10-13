# 🚀 RDS Explorer — Docker Setup (Ubuntu EC2)

Run the RDS Explorer dashboard in Docker on an Ubuntu EC2 instance.

---

## 1. Install Docker

```bash
sudo apt-get update
sudo apt-get install -y docker.io git
sudo systemctl enable --now docker
```

## 2. Get the code

```bash
cd ~
git clone https://github.com/IM-RAHUL-RAJ/Docker-test.git
cd Docker-test
```

## 3. Create the `.env` file

```bash
cp .env.example .env
vi .env
```

Set these values, then save and quit with `Esc` → `:wq` → `Enter`:

```ini
DB_ENGINE=postgresql
DB_HOST=database-1.c562y46ccn9y.ap-south-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres
DB_PASSWORD=<your-db-password>
```

> 💡 In `vi`, press `i` to start typing.

## 4. Build the image

```bash
sudo docker build -t rds-explorer .
```

## 5. Run the container

```bash
sudo docker run -d \
  --name rds-explorer \
  --env-file .env \
  -p 5000:5000 \
  --restart unless-stopped \
  rds-explorer
```

## 6. Check it works

```bash
sudo docker ps
curl localhost:5000/health
```

The health check should print `{"status":"ok"}`.

Then open the dashboard in your browser:

```
http://<EC2-PUBLIC-IP>:5000
```

---

## 🛠 Useful commands

| Task | Command |
|---|---|
| Follow the logs | `sudo docker logs -f rds-explorer` |
| Stop | `sudo docker stop rds-explorer` |
| Start again | `sudo docker start rds-explorer` |
| Remove the container | `sudo docker rm -f rds-explorer` |

## 🔄 After changing `.env` or the code

```bash
sudo docker rm -f rds-explorer
sudo docker build -t rds-explorer .
```

Then repeat step 5.
