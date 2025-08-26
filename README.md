# 🎯 AI Interview System - Production Ready Deployment Guide  

An AI-powered video interview platform that delivers **realistic, automated candidate assessments** with dynamic questioning, real-time transcription, and performance analytics.  

---

## 🚀 **Key Features**  

✅ **AI Interviewer Avatar** – Static video tile with natural-sounding TTS (Text-to-Speech)  
✅ **Dynamic Questioning** – Role-specific questions based on job description, resume, and responses  
✅ **Real-Time Transcription** – Powered by Google Cloud Speech-to-Text  
✅ **Automated Evaluation** – Assesses relevance, clarity, and completeness of answers  
✅ **Interview Summary** – AI-generated performance report post-interview  

---

## 🛠 **Tech Stack**  

| Layer               | Technology |
|---------------------|------------|
| **Frontend**        | HTML5, CSS3, JavaScript (Vanilla) |
| **Backend**         | Django (Python) |
| **Real-Time Comms** | WebRTC (video/audio), WebSockets (signaling) |
| **AI/LLM**          | Google Gemini (Q&A generation, evaluation) |
| **Speech**          | Google Cloud Speech-to-Text & Text-to-Speech |
| **Deployment**      | Nginx + Gunicorn + Daphne (ASGI) |
| **Database**        | PostgreSQL (Production) / SQLite (Dev) |

---

## 🚀 **Production Deployment**  

### **Prerequisites**  
- Linux server (Ubuntu 22.04 recommended)  
- Domain & SSL certificate (Let’s Encrypt)  
- Google Cloud service account (for Speech & Gemini APIs)  

### **1️⃣ Clone & Setup**  
```bash
git clone https://github.com/tushar7058/ai-interview-system.git
cd ai-interview-system
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### **2️⃣ Configure Environment**  
Create `.env` in the project root:  
```env
# Google Cloud
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GEMINI_API_KEY=your_api_key

# Django (Production)
SECRET_KEY=your_django_secret_key
DEBUG=False
ALLOWED_HOSTS=yourdomain.com,www.yourdomain.com
DATABASE_URL=postgres://user:password@localhost:5432/db_name
```

### **3️⃣ Database Setup (PostgreSQL)**  
```bash
sudo apt install postgresql postgresql-contrib
sudo -u postgres psql
CREATE DATABASE ai_interviews;
CREATE USER ai_user WITH PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE ai_interviews TO ai_user;
```

### **4️⃣ Run Migrations**  
```bash
python manage.py migrate
python manage.py collectstatic
```

### **5️⃣ Configure Gunicorn + Daphne (ASGI)**  
Create `gunicorn.service` (`/etc/systemd/system/gunicorn.service`):  
```ini
[Unit]
Description=Gunicorn Django ASGI
After=network.target

[Service]
User=ubuntu
Group=www-data
WorkingDirectory=/path/to/ai-interview-system
ExecStart=/path/to/venv/bin/gunicorn --bind unix:/tmp/gunicorn.sock backend.asgi:application -k uvicorn.workers.UvicornWorker
Restart=always

[Install]
WantedBy=multi-user.target
```
Start Gunicorn:  
```bash
sudo systemctl start gunicorn
sudo systemctl enable gunicorn
```

### **6️⃣ Nginx Configuration**  
Edit `/etc/nginx/sites-available/ai_interview`:  
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://unix:/tmp/gunicorn.sock;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /static/ {
        alias /path/to/ai-interview-system/staticfiles/;
    }

    location /ws/ {
        proxy_pass http://unix:/tmp/gunicorn.sock;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```
Enable & restart Nginx:  
```bash
sudo ln -s /etc/nginx/sites-available/ai_interview /etc/nginx/sites-enabled
sudo nginx -t
sudo systemctl restart nginx
```

### **7️⃣ HTTPS (SSL) Setup**  
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

## 📡 **System Workflow**  

1. **Candidate Joins** → Web UI connects, AI avatar appears.  
2. **Auto-Start** → AI greets and begins dynamic questioning.  
3. **Real-Time Transcription** → Speech-to-Text processes responses.  
4. **Dynamic Flow** → Next question adapts based on prior answers.  
5. **Evaluation & Summary** → AI generates performance report.  

---

## 🔌 **API Endpoints**  

| Endpoint            | Method | Description |
|---------------------|--------|-------------|
| `/agent/ask/`       | POST   | Get next AI-generated question |
| `/agent/evaluate/`  | POST   | Evaluate candidate response |
| `/agent/summary/`   | GET    | Retrieve interview summary |

---

## 🔒 **Security Best Practices**  
- **Django Security Middleware** (HTTPS, CSRF, CORS)  
- **Rate Limiting** (Django Ratelimit)  
- **Database Backups** (Automated via `pg_dump`)  
- **Monitoring** (Sentry for error tracking)  

---

## 📜 **License**  
MIT License – See [LICENSE](LICENSE).  

---

## 👨‍💻 **Author**  
**Tushar Kale**  
📧 tusharkale816@gmail.com | 🔗 GitHub: [tushar7058](https://github.com/tushar7058)  

---

🚀 **Ready for Production?** Deploy with confidence using this scalable, secure setup!
