import os
import re
from datetime import datetime
from typing import List, Tuple, Dict

import spacy
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer, util
from google.cloud import texttospeech
import google.generativeai as genai
from rich.console import Console

# === Load Environment ===
load_dotenv()
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")

# === Constants and Globals ===
SUMMARY_DIR = "interview_reports"
os.makedirs(SUMMARY_DIR, exist_ok=True)

EMBEDDER = SentenceTransformer("all-mpnet-base-v2")
TTS_CLIENT = texttospeech.TextToSpeechClient()
GEMINI_MODEL = genai.GenerativeModel("gemini-2.0-flash")
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

try:
    nlp = spacy.load("en_core_web_sm")
except OSError:
    from spacy.cli import download
    download("en_core_web_sm")
    nlp = spacy.load("en_core_web_sm")

console = Console()

# === Helpers ===

def read_file(filename: str) -> str:
    data_dir = "data"
    path = os.path.join(data_dir, filename)
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()

def extract_name(text: str) -> str:
    doc = nlp(text.strip())
    for ent in doc.ents:
        if ent.label_ == "PERSON":
            return ent.text.strip().title()
    match = re.search(r"(?:my name is|i am|i'm|this is|myself)\s+([A-Za-z ]+)", text, re.I)
    if match:
        return match.group(1).title()
    return "Candidate"

def call_llm(prompt: str, system_prompt: str = "") -> str:
    try:
        full_prompt = f"{system_prompt.strip()}\n\n{prompt.strip()}" if system_prompt else prompt
        response = GEMINI_MODEL.generate_content([{"role": "user", "parts": [full_prompt]}])
        return response.text.strip()
    except Exception as e:
        console.print(f"[red]LLM Error: {e}[/red]")
        return "[LLM Error]"

def save_summary(name: str, logs: List[Dict[str, str]]) -> str:
    safe_name = re.sub(r'[^a-zA-Z0-9_]', '_', name.strip().replace(" ", "_")).lower()
    timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M')
    path = os.path.join(SUMMARY_DIR, f"{safe_name}_{timestamp}.txt")
    with open(path, "w") as f:
        f.write(f"Candidate Name: {name}\nInterview Time: {timestamp}\n\n")
        for log in logs:
            f.write(f"Q: {log['question']}\nA: {log['answer']}\nFeedback: {log['feedback']}\n\n")
    return path

# === Interview Core Classes ===

class InterviewState:
    def __init__(self):
        self.candidate_name = "Candidate"
        self.self_intro = ""
        self.job_description = read_file("jd.txt")
        self.resume = read_file("resume.txt")
        self.asked_questions = []
        self.small_talk_history = []
        self.interview_logs = []
        self.feedback = ""
        self.current_stage = "greeting"

    def update_stage(self, new_stage: str):
        self.current_stage = new_stage

    def add_log(self, question: str, answer: str, feedback: str):
        self.interview_logs.append({
            "question": question,
            "answer": answer,
            "feedback": feedback
        })

class QuestionGenerator:
    def __init__(self, state: InterviewState):
        self.state = state
        self.system_message = "You are an expert interview question generator."

    def generate_small_talk(self) -> str:
        context = "\n".join(f"- {q}" for q in self.state.small_talk_history)
        prompt = f"""
Generate a short, friendly small talk question to open a conversation in a professional interview.

Avoid repeating:
{context or 'None'}

Guidelines:
- Be warm and professional.
- Avoid personal, geographic, or controversial topics.
- No explanation, just output the question.
"""
        question = call_llm(prompt, self.system_message)
        self.state.small_talk_history.append(question)
        return question

    def generate_main_question(self) -> str:
        context = "\n".join(f"- {q}" for q in self.state.asked_questions)
        prompt = f"""
Generate a concise, role-relevant interview question.

Job Description:
{self.state.job_description}

Resume:
{self.state.resume}

Self-Intro:
{self.state.self_intro}

Already Asked:
{context or 'None'}

Output only the next question.
"""
        question = call_llm(prompt, self.system_message)
        self.state.asked_questions.append(question)
        return question

    def summarize_role(self) -> str:
        prompt = f"Summarize this job description in 2 lines:\n{self.state.job_description}"
        return call_llm(prompt, self.system_message)

class Evaluator:
    def __init__(self, state: InterviewState):
        self.state = state
        self.system_message = "You are a professional evaluator of interview answers."

    def evaluate(self, question: str, answer: str) -> Tuple[float, str]:
        try:
            prompt = f"Q: {question}\nA: {answer}\nRate 1-10 and give feedback."
            result = call_llm(prompt, self.system_message)
            score_match = re.search(r"Score:\s*([0-9]+(?:\.[0-9]+)?)", result)
            feedback_match = re.search(r"Feedback:\s*(.+)", result, re.DOTALL)
            if score_match and feedback_match:
                return float(score_match.group(1)), feedback_match.group(1).strip()
        except:
            pass

        similarity = util.pytorch_cos_sim(
            EMBEDDER.encode(question, convert_to_tensor=True),
            EMBEDDER.encode(answer, convert_to_tensor=True)
        ).item()
        return round(similarity * 10, 1), "Feedback generated using fallback similarity method."

# === Interview Controller ===

class CustomAutoGenInterviewSystem:
    def __init__(self):
        self.state = InterviewState()
        self.qgen = QuestionGenerator(self.state)
        self.eval = Evaluator(self.state)

    def get_next(self, user_input: str = "") -> Dict:
        stage = self.state.current_stage

        if stage == "greeting":
            self.state.self_intro = user_input or ""
            self.state.candidate_name = extract_name(self.state.self_intro)
            self.state.update_stage("small_talk")
            return {
                "reply": f"Nice to meet you, {self.state.candidate_name}!",
                "question": self.qgen.generate_small_talk(),
                "stage": "small_talk"
            }

        elif stage == "small_talk":
            self.state.small_talk_history.append(user_input)
            if len(self.state.small_talk_history) >= 2:
                self.state.update_stage("role_overview")
                summary = self.qgen.summarize_role()
                return {
                    "reply": "Thanks! Here's a quick overview of the role.",
                    "question": summary,
                    "stage": "role_overview"
                }
            return {
                "reply": "Thanks!",
                "question": self.qgen.generate_small_talk(),
                "stage": "small_talk"
            }

        elif stage == "role_overview":
            self.state.update_stage("main_questions")
            question = self.qgen.generate_main_question()
            return {
                "reply": "Let's begin the main interview.",
                "question": question,
                "stage": "main_questions"
            }

        elif stage == "main_questions":
            if self.state.asked_questions:
                last_question = self.state.asked_questions[-1]
                score, feedback = self.eval.evaluate(last_question, user_input)
                self.state.add_log(last_question, user_input, f"{feedback} (Score: {score}/10)")
            if len(self.state.asked_questions) >= 5:
                self.state.update_stage("feedback")
                return {
                    "reply": "Thank you! Do you have any feedback on this interview?",
                    "stage": "feedback"
                }
            question = self.qgen.generate_main_question()
            return {
                "reply": feedback,
                "question": question,
                "stage": "main_questions"
            }

        elif stage == "feedback":
            self.state.feedback = user_input
            self.state.update_stage("conclusion")
            path = save_summary(self.state.candidate_name, self.state.interview_logs)
            return {
                "reply": f"Thank you {self.state.candidate_name}. Interview summary saved.",
                "summary_path": path,
                "stage": "done"
            }

        return {"error": "Invalid stage", "stage": stage}