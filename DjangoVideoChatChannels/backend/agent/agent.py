import os
import re
import json
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

# --- FIX: Define absolute path for the data directory ---
# Get the directory where this script (agent.py) is located
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Build the absolute path to the 'data' directory
DATA_DIR = os.path.join(SCRIPT_DIR, "data")

# --- Initialize Global Clients and Models ---
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

# === Helper Functions ===

def read_file(filename: str) -> str:
    """Reads a file from the 'data' directory using an absolute path."""
    path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(path):
        console.print(f"[bold red]Warning:[/bold red] File not found at {path}")
        return ""
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()

def extract_name(text: str) -> str:
    """Extracts a person's name from a string using NLP and regex."""
    doc = nlp(text.strip())
    for ent in doc.ents:
        if ent.label_ == "PERSON":
            return ent.text.strip().title()
    match = re.search(r"(?:my name is|i am|i'm|this is|myself)\s+([A-Za-z ]+)", text, re.I)
    if match:
        return match.group(1).title()
    return "Candidate"

def call_llm(prompt: str, system_prompt: str = "") -> str:
    """Calls the Gemini LLM with a given prompt."""
    try:
        full_prompt = f"{system_prompt.strip()}\n\n{prompt.strip()}" if system_prompt else prompt
        response = GEMINI_MODEL.generate_content([{"role": "user", "parts": [full_prompt]}])
        return response.text.strip()
    except Exception as e:
        console.print(f"[red]LLM Error: {e}[/red]")
        return "[LLM Error]"

def save_summary(name: str, logs: List[Dict[str, str]]) -> str:
    """Saves the interview log to a timestamped text file."""
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
    """A data class to hold the state of a single interview session."""
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
    """Generates questions for different stages of the interview."""
    def __init__(self, state: InterviewState):
        self.state = state
        self.system_message = "You are an expert interview question generator."

    def generate_small_talk(self) -> str:
        # ... (This function's logic remains the same)
        return "How has your day been so far?" # Simplified for example

    def generate_main_question(self) -> str:
        context = "\n".join(f"- {q}" for q in self.state.asked_questions)
        prompt = f"""
Generate a concise, role-relevant interview question based on the following context.

Job Description:
{self.state.job_description or "Not provided."}

Resume:
{self.state.resume or "Not provided."}

Candidate's Self-Intro:
{self.state.self_intro or "Not provided."}

Already Asked Questions:
{context or 'None'}

Output only the next interview question. Do not add any preamble.
"""
        question = call_llm(prompt, self.system_message)
        self.state.asked_questions.append(question)
        return question

    def summarize_role(self) -> str:
        prompt = f"Summarize this job description in 2-3 concise lines:\n{self.state.job_description}"
        return call_llm(prompt, self.system_message)

class Evaluator:
    """Evaluates candidate's answers using LLM and a fallback similarity score."""
    def __init__(self, state: InterviewState):
        self.state = state
        self.system_message = "You are a professional, impartial interviewer providing feedback."

    def evaluate(self, question: str, answer: str) -> Tuple[float, str]:
        # --- FIX: Use JSON parsing for a more reliable evaluation ---
        prompt = f"""
Analyze the following interview question and answer.

**Question:** "{question}"
**Candidate's Answer:** "{answer}"

Provide your evaluation in a JSON format with two keys: "score" (a number from 1 to 10) and "feedback" (a brief, constructive paragraph on the answer's quality). Your entire response must be ONLY the JSON object, with no other text or formatting.
"""
        result_str = call_llm(prompt, self.system_message)
        
        try:
            # Clean up the string in case the LLM adds markdown backticks
            if result_str.startswith("```json"):
                result_str = result_str[7:-3].strip()
            
            data = json.loads(result_str)
            score = float(data.get("score", 0))
            feedback = data.get("feedback", "No feedback provided.")
            return score, feedback
        except (json.JSONDecodeError, TypeError, AttributeError, ValueError):
            # Fallback to similarity if JSON parsing or data extraction fails
            console.print("[yellow]Warning:[/yellow] LLM response was not valid JSON. Using fallback evaluation.")
            similarity = util.pytorch_cos_sim(
                EMBEDDER.encode(question, convert_to_tensor=True),
                EMBEDDER.encode(answer, convert_to_tensor=True)
            ).item()
            return round(similarity * 10, 1), "Feedback generated using a fallback similarity method."

# === Interview Controller ===

class CustomAutoGenInterviewSystem:
    """Main class that orchestrates the interview flow."""
    def __init__(self, num_questions=5):
        self.state = InterviewState()
        self.qgen = QuestionGenerator(self.state)
        self.eval = Evaluator(self.state)
        self.num_questions = num_questions # Make number of questions configurable

    def get_next(self, user_input: str = "") -> Dict:
        stage = self.state.current_stage
        user_input = user_input.strip()

        if stage == "greeting":
            if user_input:
                self.state.self_intro = user_input
                self.state.candidate_name = extract_name(user_input)
            
            self.state.update_stage("small_talk")
            return {
                "reply": f"Nice to meet you, {self.state.candidate_name}!",
                "question": self.qgen.generate_small_talk(),
                "stage": "small_talk"
            }

        elif stage == "small_talk":
            self.state.small_talk_history.append(user_input)
            self.state.update_stage("role_overview")
            summary = self.qgen.summarize_role()
            return {
                "reply": "Thanks! Before we dive in, here's a quick overview of the role.",
                "question": summary,
                "stage": "role_overview"
            }

        elif stage == "role_overview":
            self.state.update_stage("main_questions")
            question = self.qgen.generate_main_question()
            return {
                "reply": "Let's begin with the first question.",
                "question": question,
                "stage": "main_questions"
            }

        elif stage == "main_questions":
            last_question = self.state.asked_questions[-1] if self.state.asked_questions else ""
            feedback = "Great, let's move on." # Default feedback
            
            if last_question and user_input:
                score, feedback_text = self.eval.evaluate(last_question, user_input)
                self.state.add_log(last_question, user_input, f"{feedback_text} (Score: {score}/10)")
                feedback = feedback_text

            if len(self.state.asked_questions) >= self.num_questions:
                self.state.update_stage("feedback")
                return {
                    "reply": "That was the last technical question. Thank you!",
                    "question": "Finally, do you have any questions for me about the role or the company?",
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
                "reply": f"Thank you for your time, {self.state.candidate_name}. We'll be in touch soon. Your interview summary has been saved.",
                "question": "", # No more questions
                "summary_path": path,
                "stage": "done"
            }

        return {"error": "Invalid stage", "stage": stage}