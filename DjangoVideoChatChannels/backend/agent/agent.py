# agent/agent.py

import os
import re
import json
import random
from datetime import datetime
from typing import List, Dict, TypedDict, Literal
from enum import Enum


import spacy
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer, util
import google.generativeai as genai
from rich.console import Console

from langgraph.graph import StateGraph, END

# ==============================================================================
# 1. SETUP AND CONFIGURATION
# ==============================================================================
# --- Load Environment and Models ---
load_dotenv()
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# --- Paths ---
SUMMARY_DIR = "interview_reports"
os.makedirs(SUMMARY_DIR, exist_ok=True)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "data") # Assumes a 'data' folder next to agent.py

# --- Models & API Setup ---
try:
    EMBEDDER = SentenceTransformer("all-mpnet-base-v2")
    genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
    GEMINI_MODEL = genai.GenerativeModel("gemini-1.5-flash") # Updated model name for clarity
    NLP = spacy.load("en_core_web_sm")
except Exception as e:
    print(f"Error loading a model: {e}. Some features may be disabled.")
    EMBEDDER, GEMINI_MODEL, NLP = None, None, None

console = Console()

# ==============================================================================
# 2. STATELESS UTILITIES
# ==============================================================================

def read_file(filename: str) -> str:
    """Reads a file. Exposed for use by the Django view."""
    path = os.path.join(DATA_DIR, filename)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    console.print(f"[yellow]Warning:[/yellow] Missing file: {path}")
    return ""

def call_llm(prompt: str, system_prompt: str = "") -> str:
    """Calls the Generative AI model with a given prompt."""
    if not GEMINI_MODEL: return "LLM is not available."
    try:
        full_prompt = f"{system_prompt.strip()}\n\n{prompt.strip()}" if system_prompt else prompt
        response = GEMINI_MODEL.generate_content(full_prompt)
        return response.text.strip()
    except Exception as e:
        console.print(f"[red]LLM Error:[/red] {e}")
        return "There was an error communicating with the language model."

# --- NEW ROBUST NAME EXTRACTION FUNCTION ---
def extract_name(text: str) -> str | None:
    """
    Extracts a person's name from a string using a multi-step approach.

    This function attempts to find a name in the following order:
    1. spaCy's Named Entity Recognition (NER) to identify 'PERSON' entities.
    2. A call to the Gemini LLM as a powerful fallback for conversational text.
    3. Regex patterns for common phrases like "My name is...".

    Args:
        text: The input string from the user, potentially containing a name.

    Returns:
        The extracted full name, properly capitalized, or None if no name is found.
    """
    text = text.strip()
    if not text:
        return None

    # Method 1: spaCy Named Entity Recognition (fast and local)
    if NLP:
        doc = NLP(text)
        person_ents = [ent.text for ent in doc.ents if ent.label_ == "PERSON"]
        if person_ents:
            full_name = " ".join(person_ents)
            return " ".join([name.capitalize() for name in full_name.split()])

    # Method 2: LLM as a powerful fallback
    if GEMINI_MODEL:
        prompt = (
            "You are a highly accurate name extraction system. "
            f"From the following text, extract only the person's full name. "
            "Do not add any explanation or preamble. If no name is present, respond with the exact word 'NONE'.\n\n"
            f"Text: \"{text}\""
        )
        llm_response = call_llm(prompt).strip()
        if llm_response.upper() != 'NONE' and len(llm_response) > 2:
             return llm_response.title()

    # Method 3: Regex for simple, common patterns
    # Handles "My name is John Doe", "I'm Jane", "call me Alex", etc.
    match = re.search(r"(?:my\s+name\s+is|I'm|I\s+am|call\s+me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)", text, re.IGNORECASE)
    if match:
        return match.group(1).title()

    # If no pattern matches, assume the whole string might be the name if it looks like one.
    if len(text.split()) <= 3 and re.match(r"^[A-Za-z\s'-]+$", text):
        return text.title()
        
    return None

def save_summary_as_json(name: str, logs: List[Dict]):
    """Saves the interview log to a JSON file."""
    safe_name = re.sub(r'[^a-zA-Z0-9_]', '_', name.strip()).lower() or "unknown_candidate"
    timestamp = datetime.now().strftime('%Y-%m-%dT%H-%M-%S')
    path = os.path.join(SUMMARY_DIR, f"{safe_name}_{timestamp}.json")
    summary_data = {
        "candidateName": name,
        "interviewTimestamp": timestamp,
        "conversationLog": logs
    }
    with open(path, "w", encoding='utf-8') as f:
        json.dump(summary_data, f, indent=4)
    console.print(f"\n[green]Interview summary saved to {path}[/green]")

# ==============================================================================
# 3. AGENT TOOLS (Re-usable Components)
# ==============================================================================

class QuestionGenerator:
    """Generates main and transitional questions."""
    def __init__(self):
        self.system_prompt = "You are a friendly and professional AI interviewer."

    def generate(self, state: Dict) -> str:
        prompt = (
            "Generate one concise, role-specific interview question based on the provided job description and resume.\n"
            f"Avoid asking questions similar to these already asked: {', '.join(state.get('asked_questions', [])) or 'None'}\n"
            f"Job Description: {state.get('job_description', 'N/A')}\n"
            f"Resume: {state.get('resume', 'N/A')}\n"
            "Output only the question text, without any preamble."
        )
        return (call_llm(prompt, self.system_prompt) or "Could you tell me about your most relevant experience?").strip()

    def transition(self) -> str:
        fallback = [ "Got it.", "That makes sense."]
        prompt = " Generate a short, professional transition phrase (under 8 words) like 'Alright, thank you.' or 'Okay, moving on.' to proceed to the next question. The phrase must be polite and concise. "
        return (call_llm(prompt, self.system_prompt) or random.choice(fallback)).strip()

class FollowUpGenerator:
    """Generates a follow-up question if an answer lacks detail."""
    def __init__(self):
        self.system_prompt = "You are an expert interviewer. Your job is to analyze a candidate's answer and ask one, probing follow-up question to gain more clarity. If the answer is sufficiently detailed, respond with only the exact text 'NO_FOLLOWUP'."

    def generate(self, question: str, answer: str) -> str:
        prompt = f"Original Question: \"{question}\"\nCandidate's Answer: \"{answer}\"\n\nBased on the answer, what is one concise follow-up question? If none is needed, just say 'NO_FOLLOWUP'."
        follow_up = call_llm(prompt, self.system_prompt)
        return "NO_FOLLOWUP" if "NO_FOLLOWUP" in follow_up or len(follow_up) < 10 else follow_up.strip()

# evaluater agent 
class Evaluator:
    """Human-like evaluator with weighted scoring for answers."""

    def __init__(self):
        self.criteria_weights = {
            "clarity": 0.2,
            "relevance": 0.3,
            "depth": 0.3,
            "completeness": 0.1,
            "communication": 0.1,
        }

        self.system_prompt = (
            "You are an expert recruiter with Technical Knowledge.  "
            "Evaluate the candidate's answer on clarity, relevance, depth, completeness, and communication. "
            "Return JSON with integer scores 1–10 for each criterion, and a short overall feedback string. "
            "Example:\n"
            "{"
            "\"clarity\": 7, \"relevance\": 9, \"depth\": 6, \"completeness\": 8, "
            "\"communication\": 7, \"feedback\": \"Good structure, but more detail needed.\"}"
        )

    def _extract_json(self, text: str) -> dict:
        match = re.search(r'```json\s*([\s\S]+?)\s*```', text)
        text_to_load = match.group(1) if match else text
        try:
            return json.loads(text_to_load)
        except json.JSONDecodeError:
            return {}

    def _normalize_score(self, score: float) -> float:
        """Clamp score to [1, 10]."""
        if not isinstance(score, (int, float)):
            return 0.0
        return max(1.0, min(10.0, float(score)))

    def evaluate(self, question: str, answer: str) -> tuple[float, str]:
        if not answer.strip():
            return 1.0, "No answer provided."

        prompt = (
            f"Evaluate the candidate's response.\n\n"
            f"Question: {question}\n"
            f"Answer: {answer}\n\n"
            "Return a JSON with scores for clarity, relevance, depth, completeness, communication (1–10 each), "
            "and a short constructive 'feedback'."
        )

        # Call LLM
        result = self._extract_json(call_llm(prompt, self.system_prompt))

        # Weighted scoring
        total_score = 0.0
        for criterion, weight in self.criteria_weights.items():
            total_score += weight * self._normalize_score(result.get(criterion, 0))

        feedback = result.get("feedback", "").strip()

        # Fallback if LLM fails
        if total_score <= 1 or not feedback:
            if EMBEDDER:
                similarity = util.pytorch_cos_sim(
                    EMBEDDER.encode(question),
                    EMBEDDER.encode(answer)
                ).item()
                total_score = round(similarity * 10, 1)
                feedback = (
                    "The response has some relevance but lacks depth or clarity. "
                    "Provide more structured and detailed points."
                )

        if not feedback:
            feedback = "Answer was too brief or unclear. Expand with more details."

        return round(total_score, 1), feedback


# Instantiate tools once to be used by the agent nodes
evaluator_tool = Evaluator()
follow_up_tool = FollowUpGenerator()
question_gen_tool = QuestionGenerator()

# ==============================================================================
# 4. LANGGRAPH STATE DEFINITION
# ==============================================================================
class InterviewState(TypedDict):
    """
    Represents the complete state of a single interview session.
    This state is passed into and out of the graph at each turn.
    """
    # --- Core Interview Data (managed by the caller, e.g., Django view) ---
    candidate_name: str
    job_description: str
    resume: str
    user_input: str
    num_questions_total: int
    asked_questions: List[str]
    interview_logs: List[Dict]

    # --- Output for the Client (populated by graph nodes) ---
    reply_to_user: str
    question_for_user: str
    
    # --- Internal Graph State & Routing ---
    current_stage: str
    _last_question_asked: str
    _pending_follow_up_q: str
    _is_follow_up_turn: bool

# ==============================================================================
# 5. AGENT NODES
# ==============================================================================

def greeting_node(state: InterviewState) -> Dict:
    """Greets the user and asks for their name."""
    return {
        "reply_to_user": "Hello! I'm your AI interviewer for today.",
        "question_for_user": "To begin, could you please tell me your full name?",
        "current_stage": "name_capture"
    }

# --- UPDATED capture_name_node ---
def capture_name_node(state: InterviewState) -> Dict:
    """Captures the candidate's name using robust extraction and introduces the role."""
    user_response = state["user_input"]
    
    # Use the new robust extraction function
    extracted_name = extract_name(user_response)
    
    # Fallback logic: if extraction fails, use the original input, otherwise default to "Candidate"
    name = extracted_name or user_response.title().strip() or "Candidate"
    
    jd_summary = call_llm(f"Summarize this job description in one friendly sentence for a candidate named {name}:\n{state['job_description']}")
    
    return {
        "candidate_name": name,
        "reply_to_user": f"It's a pleasure to meet you, {name}! {jd_summary}",
        "question_for_user": "Are you ready to begin?",
        "current_stage": "start_confirmation"
    }

def ask_main_question_node(state: InterviewState) -> Dict:
    """Generates and asks a new primary interview question."""
    reply = question_gen_tool.transition() if state.get('asked_questions') else "Great! Let's dive right in."
    question = question_gen_tool.generate(state)
        
    return {
        "reply_to_user": reply,
        "question_for_user": question,
        "current_stage": "awaiting_answer",
        "_last_question_asked": question,
        "asked_questions": state.get('asked_questions', []) + [question],
        "_is_follow_up_turn": False,
    }

def process_answer_node(state: InterviewState) -> Dict:
    """Processes the user's answer: evaluates it, logs it, and checks for a follow-up."""
    last_q = state["_last_question_asked"]
    user_answer = state["user_input"].strip()

    # 💡 New logic: handle empty/no answer
    if not user_answer:
        new_log = {
            "question": last_q,
            "answer": "(No response provided)",
            "evaluation": {
                "score": 0.0,
                "feedback": "No answer was given, so we are moving to the next question."
            }
        }

        return {
            "interview_logs": state.get("interview_logs", []) + [new_log],
            "_pending_follow_up_q": "NO_FOLLOWUP",  # Skip follow-up
            "_is_follow_up_turn": state.get("_is_follow_up_turn", False)
        }

    # Existing logic
    score, feedback = evaluator_tool.evaluate(last_q, user_answer)
    new_log = {"question": last_q, "answer": user_answer, "evaluation": {"score": score, "feedback": feedback}}
    follow_up_q = follow_up_tool.generate(last_q, user_answer)
    
    return {
        "interview_logs": state.get("interview_logs", []) + [new_log],
        "_pending_follow_up_q": follow_up_q,
        "_is_follow_up_turn": state.get("_is_follow_up_turn", False)
    }


def ask_follow_up_node(state: InterviewState) -> Dict:
    """Asks the generated follow-up question."""
    follow_up_q = state["_pending_follow_up_q"]
    return {
        "reply_to_user": "Thanks. To elaborate on that a bit...",
        "question_for_user": follow_up_q,
        "current_stage": "awaiting_answer",
        "_last_question_asked": follow_up_q,
        "_pending_follow_up_q": "NO_FOLLOWUP", # Reset after asking
        "_is_follow_up_turn" : True,
    }

def conclusion_node(state: InterviewState) -> Dict:
    """Ends the interview, saves the summary, and provides closing remarks."""
    save_summary_as_json(state["candidate_name"], state["interview_logs"])
    return {
        "reply_to_user": f"That brings us to the end of our questions, {state['candidate_name']}. Thank you for your time today.",
        "question_for_user": "We will review your responses and the team will be in touch. Have a great day!",
        "current_stage": "done"
    }

# ==============================================================================
# 6. CONDITIONAL ROUTING LOGIC
# ==============================================================================

class RoutingDecision(Enum):
    ASK_FOLLOW_UP = "ask_follow_up"
    ASK_MAIN_QUESTION = "ask_main_question"
    CONCLUDE = "conclude"

def route_by_stage(state: InterviewState) -> str:
    """Entry point router that directs the graph based on the interview's current stage."""
    stage = state.get("current_stage")

    if not stage:
        return "greeting"
    if stage == "name_capture":
        return "capture_name"
    if stage == "start_confirmation":
        user_intent = state.get("user_input", "").lower()
        if any(word in user_intent for word in ["yes", "ready", "ok", "sure", "fine"]):
            return "ask_main_question"
        return "conclusion" # If user isn't ready, end gracefully
    if stage == "awaiting_answer":
        return "process_answer"
    return END

def route_after_processing(state: InterviewState) -> RoutingDecision:
    """After processing an answer, decides what to do next."""
    # --- MODIFIED: Check the flag first ---
    # If the user just answered a follow-up, ALWAYS move to the next main question.
    if state.get("_is_follow_up_turn"):
        # Check if we should conclude or ask another main question
        if len(state.get("asked_questions", [])) >= state.get("num_questions_total", 5):
            return RoutingDecision.CONCLUDE
        return RoutingDecision.ASK_MAIN_QUESTION

    # If it was a main question, check if a follow-up is needed.
    if state.get("_pending_follow_up_q") != "NO_FOLLOWUP":
        return RoutingDecision.ASK_FOLLOW_UP
    
    # If no follow-up is needed, check if we should conclude or ask a new main question.
    if len(state.get("asked_questions", [])) >= state.get("num_questions_total", 5):
        return RoutingDecision.CONCLUDE
        
    return RoutingDecision.ASK_MAIN_QUESTION


# ==============================================================================
# 7. AGENTIC INTERVIEW SYSTEM
# ==============================================================================
class AgenticInterviewSystem:
    def __init__(self):
        self.app = self._build_graph()

    def _build_graph(self):
        """Builds the LangGraph StateGraph with conditional, turn-based routing."""
        workflow = StateGraph(InterviewState)

        workflow.add_node("greeting", greeting_node)
        workflow.add_node("capture_name", capture_name_node)
        workflow.add_node("ask_main_question", ask_main_question_node)
        workflow.add_node("process_answer", process_answer_node)
        workflow.add_node("ask_follow_up", ask_follow_up_node)
        workflow.add_node("conclude", conclusion_node)

        # The entry point is a router that checks the `current_stage`.
        workflow.set_conditional_entry_point(
            route_by_stage,
            {
                "greeting": "greeting",
                "capture_name": "capture_name",
                "ask_main_question": "ask_main_question",
                "process_answer": "process_answer",
                "conclude": "conclude",
                END: END
            }
        )

        # Nodes that need user input terminate the graph for the current turn.
        workflow.add_edge("greeting", END)
        workflow.add_edge("capture_name", END)
        workflow.add_edge("ask_main_question", END)
        workflow.add_edge("ask_follow_up", END)
        workflow.add_edge("conclude", END)

        # The 'process_answer' node immediately routes to the next action within the same turn.
        workflow.add_conditional_edges(
            "process_answer",
            lambda state: route_after_processing(state).value,
            {
                RoutingDecision.ASK_FOLLOW_UP.value: "ask_follow_up",
                RoutingDecision.ASK_MAIN_QUESTION.value: "ask_main_question",
                RoutingDecision.CONCLUDE.value: "conclude"
            }
        )
        
        return workflow.compile()

    def invoke(self, current_state: Dict) -> Dict:
        # ... (no changes to this function)
        current_state['reply_to_user'] = ""
        current_state['question_for_user'] = ""
        # Initialize the new flag if it's not present
        if "_is_follow_up_turn" not in current_state:
            current_state["_is_follow_up_turn"] = False
        return self.app.invoke(current_state)