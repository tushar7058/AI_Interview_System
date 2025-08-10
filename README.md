

⸻

🎯 AI Interview System

An AI-powered video interview platform that delivers realistic, structured, and automated candidate interviews.
It features a static AI interviewer avatar that asks dynamic, role-specific questions, listens via real-time transcription, evaluates answers, and generates a performance summary.

⸻

📌 Features
	•	🎭 Static AI Interviewer Avatar
Appears as a static video tile — no live audio/video from the agent.
	•	🧠 Dynamic Questioning
AI generates concise, role-specific questions based on:
	•	Job description
	•	Candidate resume
	•	Self-introduction
	•	Previous answers
	•	🎙 Live Transcription
Real-time transcription using Google Cloud Speech-to-Text.
	•	🔊 Text-to-Speech
AI questions converted into natural-sounding speech via Google Cloud Text-to-Speech.
	•	⚡ Auto-Start Interviews
The AI interviewer starts automatically when the candidate joins.
	•	📈 Answer Evaluation (Implemented / Planned)
Evaluates answers for relevance, completeness, and clarity.
	•	📝 Interview Summarization (Implemented / Planned)
Generates a summary of candidate performance.

⸻

🛠 Tech Stack

Layer	Technology
Frontend	HTML5, CSS3, JavaScript (Vanilla)
Backend	Django (Python)
Real-Time	WebRTC (video/audio), WebSockets (signaling, transcription)
AI/LLM	Google Gemini (question generation, evaluation)
Speech	Google Cloud Speech-to-Text, Google Cloud Text-to-Speech
Deploy	Nginx + Gunicorn + Daphne (local or cloud)


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

Create a .env file in the root:

GOOGLE_CLOUD_PROJECT=your_project_id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GEMINI_API_KEY=your_gemini_api_key

5️⃣ Apply Migrations

python manage.py migrate

6️⃣ Start the Development Server

daphne -p 8080 backend.asgi:application


⸻

📡 How It Works
	1.	Candidate Joins → Candidate connects via web UI, AI avatar appears.
	2.	Automatic Start → AI greets and begins asking questions.
	3.	Live Transcription → Candidate’s voice transcribed in real time.
	4.	Dynamic Flow → Next question based on prior answers & context.
	5.	Evaluation & Summary → AI evaluates and summarizes the interview.

⸻

🧩 API Endpoints

Endpoint	Method	Description
/agent/ask/	POST	Sends transcript, returns next question
/agent/evaluate/	POST	Evaluates a candidate answer
/agent/summary/	GET	Returns interview summary


⸻

📷 Project Screenshots

Add your screenshots to the images/ folder, then update the paths below.
Keep file sizes optimized (under 500KB each) for faster loading.

Main interview interface with candidate video & AI avatar.

Dynamic AI-generated question sequence.

Real-time transcription of candidate responses.

⸻

🧪 Testing

daphne -p 8080 backend.asgi:application


⸻

📜 License

This project is licensed under the MIT License – see the LICENSE file for details.

⸻

👨‍💻 Author

Tushar Kale
📧 Email: tusharkale816@gmail.com
🔗 GitHub: tushar7058

⸻

