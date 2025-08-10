# 🎯 AI Interview System

An AI-powered video interview platform for realistic, structured, and automated candidate interviews.
The system features a static AI interviewer avatar that asks dynamic, role-specific questions, listens to candidate responses via live transcription, evaluates answers, and generates performance summaries.

⸻

📌 Features

🎭 Static AI Interviewer Avatar
	•	Displays as a static video tile — no live audio/video from the agent.

🧠 Dynamic Questioning
	•	AI interviewer generates concise, role-specific questions based on:
	•	Job description
	•	Candidate resume
	•	Self-introduction
	•	Previous answers

🎙 Live Transcription Integration
	•	Real-time transcription of candidate answers via Google Cloud Speech-to-Text.

🔊 Text-to-Speech for AI Questions
	•	AI questions converted into natural-sounding audio via Google Cloud Text-to-Speech.

⚡ Automated Start
	•	Interview begins automatically when the candidate joins.

📈 Answer Evaluation (Implemented / Planned)
	•	AI evaluates answers for relevance, completeness, and clarity.

📝 Interview Summarization (Implemented / Planned)
	•	AI generates a summary of the candidate’s performance at the end.

⸻

🛠 Tech Stack

Layer	Technology
Frontend	HTML5, CSS3, JavaScript (Vanilla)
Backend	Django (Python)
Real-Time	WebRTC for video/audio streaming, WebSockets for signaling & transcription
AI/LLM	Google Gemini for question generation & evaluation
Speech	Google Cloud Speech-to-Text, Google Cloud Text-to-Speech
Deploy	Local or cloud-based server deployment (Nginx, Gunicorn, Daphne)


⸻

🚀 Installation & Setup

1️⃣ Clone the Repository

git clone https://github.com/yourusername/ai-interview-system.git
cd ai-interview-system

2️⃣ Create a Virtual Environment

python -m venv venv
source venv/bin/activate   # Mac/Linux
venv\Scripts\activate      # Windows

3️⃣ Install Dependencies

pip install -r requirements.txt

4️⃣ Configure Environment Variables

Create a .env file in the project root:

GOOGLE_CLOUD_PROJECT=your_project_id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GEMINI_API_KEY=your_gemini_api_key

5️⃣ Apply Migrations

python manage.py migrate

6️⃣ Start the Development Server

daphne -p 8080 backend.asgi:application


⸻

📡 How It Works
	1.	Candidate Joins → The candidate connects via the web interface, AI avatar appears.
	2.	Automatic Start → AI agent greets and begins asking questions.
	3.	Live Transcription → Candidate responses transcribed in real time.
	4.	Dynamic Flow → Next question is based on prior answers & context.
	5.	Evaluation & Summary → AI optionally evaluates and summarizes.

⸻

🧩 API Endpoints

Endpoint	Method	Description
/agent/ask/	POST	Sends transcript & returns next question
/agent/evaluate/	POST	Evaluates a candidate answer
/agent/summary/	GET	Returns interview summary


⸻

🧪 Testing

daphne -p 8080 backend.asgi:application



👨‍💻 Author

Tushar Kale
📧 Email: tusharkale816@gmail.com
🔗 GitHub: tushar7058

⸻

