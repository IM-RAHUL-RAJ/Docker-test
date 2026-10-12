# ---- 1. Start from a small official Python image ----
FROM python:3.12-slim

# ---- 2. Sensible Python settings for containers ----
#  - don't write .pyc files, and print logs immediately
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ---- 3. Work inside /app ----
WORKDIR /app

# ---- 4. Install dependencies first (cached unless requirements.txt changes) ----
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---- 5. Copy the application code ----
COPY . .

# ---- 6. Don't run as root ----
RUN useradd --create-home appuser
USER appuser

# ---- 7. The app listens on port 5000 ----
EXPOSE 5000

# ---- 8. Start with gunicorn (production web server) ----
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--timeout", "60", "app:app"]
