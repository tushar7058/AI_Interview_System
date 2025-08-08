# 🎯 AI Interview System

An AI-powered video interview platform that enables realistic, structured, and automated candidate interviews.  
The system simulates a **static AI interviewer avatar** that asks dynamic, role-specific questions, listens to candidate responses via **live transcription**, evaluates answers, and provides **summarization**.

---

## 📌 Features

- **Static AI Interviewer Avatar**  
  Appears as a static video tile—no live video/audio from the agent.
  
- **Dynamic Questioning**  
  AI interviewer asks concise, role-specific questions based on:
  - Job description
  - Candidate resume
  - Self-introduction
  - Previous answers

- **Live Transcription Integration**  
  Real-time transcription of candidate responses using Google Cloud Speech-to-Text.

- **Text-to-Speech for AI Questions**  
  AI interviewer questions are converted to speech and played in the interview.

- **Automated Start**  
  AI agent begins asking questions automatically when a candidate joins.

- **Answer Evaluation** *(Planned / Implemented)*  
  AI agent evaluates candidate answers for relevance and quality.

- **Interview Summarization** *(Planned / Implemented)*  
  AI agent generates a summary of the candidate’s performance.

---

## 🛠 Tech Stack

| Layer             | Technology                                                                 |
| ----------------- | -------------------------------------------------------------------------- |
| **Frontend**      | HTML5, CSS3, JavaScript (Vanilla)                                          |
| **Backend**       | Django (Python)                                                            |
| **Real-Time**     | WebRTC for video/audio streaming, WebSockets for signaling & transcription |
| **AI/LLM**        | Google Gemini for question generation & evaluation                         |
| **Speech**        | Google Cloud Speech-to-Text, Google Cloud Text-to-Speech                   |
| **Deployment**    | Works locally & deployable to cloud servers                                |

---


## 🚀 Installation & Setup

### 1️⃣ Clone the Repository
```bash
git clone https://github.com/yourusername/ai-interview-system.git
cd ai-interview-system

2️⃣ Create a Virtual Environment

python -m venv venv
source venv/bin/activate   # Mac/Linux
venv\Scripts\activate      # Windows

3️⃣ Install Dependencies

pip install -r requirements.txt

4️⃣ Configure Environment Variables

Create a .env file in the project root and set:

GOOGLE_CLOUD_PROJECT=your_project_id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GEMINI_API_KEY=your_gemini_api_key

5️⃣ Run Migrations

python manage.py migrate

6️⃣ Start the Development Server

daphne -p 8080 backend.asgi:application


⸻

📡 How It Works
	1.	Candidate Joins Interview
	•	The candidate connects via the web UI.
	•	AI agent avatar is shown as a static tile.
	2.	AI Agent Starts Automatically
	•	Agent greets the candidate and begins asking questions.
	3.	Live Transcription
	•	Candidate’s audio is transcribed in real time.
	4.	Dynamic Question Flow
	•	Agent generates the next question based on context and prior responses.
	5.	Evaluation & Summarization
	•	Optional modules analyze answers and summarize performance.

⸻

🧩 API Endpoints

Endpoint	Method	Description
/agent/ask/	POST	Sends candidate transcript, gets next question
/agent/evaluate/	POST	Evaluates a given candidate answer
/agent/summary/	GET	Returns a summary of the interview


⸻

🖼 UI Overview
	•	Left Panel – Candidate’s video
	•	Right Panel – Static AI interviewer avatar
	•	Bottom Section – Live transcription display
	•	Top Section – Current AI question

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
---
