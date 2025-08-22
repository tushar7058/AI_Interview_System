import json
from django.http import JsonResponse
from django.views.decorators.http import require_POST
from django.views.decorators.csrf import csrf_exempt

# Import the agent system and utility functions from your agent.py file
# The '.' indicates a relative import from the same app directory.
from .agent import AgenticInterviewSystem, read_file

# --- Agent Initialization ---
# Instantiate the agent system once when the Django server starts.
# The agent itself is stateless; the interview's state is passed in with each API call.
agent_system = AgenticInterviewSystem()

@csrf_exempt
@require_POST
def interview_turn(request):
    """
    Handles a single turn of the AI-driven interview.

    This view acts as thendpoe central API int for the interview process. It's designed
    to be stateless on the server, relying on the client to maintain the interview's
    state between turns.

    ## API Contract

    ### Initial Request (First Turn)
    The first request initializes the interview. The body must contain file references
    for the job description and resume.

    **Body:**
    ```json
    {
        "jobDescriptionFile": "software_engineer_jd.txt",
        "resumeFile": "candidate_resume.txt",
        "numQuestions": 5,
        "userInput": ""
    }
    ```

    ### Subsequent Requests
    All subsequent requests must include the full `state` object returned by the
    previous call, along with the candidate's latest `userInput`.

    **Body:**
    ```json
    {
        "state": { ... full state object from previous response ... },
        "userInput": "The candidate's answer to the last question."
    }
    ```
    """
    try:
        data = json.loads(request.body)
        state = data.get('state')
        user_input = data.get('userInput', '')

        # --- Determine current state (initial or subsequent turn) ---
        if state is None:
            # This is the FIRST TURN. We initialize the state from scratch.
            jd_file = data.get('jobDescriptionFile')
            resume_file = data.get('resumeFile')
            num_questions = data.get('numQuestions', 5) # Default to 5 questions

            if not jd_file or not resume_file:
                return JsonResponse({
                    'error': '`jobDescriptionFile` and `resumeFile` are required for the first call.'
                }, status=400)

            # Prepare the initial state dictionary for the agent.
            # The agent's entry router will see that 'current_stage' is missing
            # and will correctly route to the 'greeting_node'.
            current_state = {
                "job_description": read_file(jd_file),
                "resume": read_file(resume_file),
                "num_questions_total": int(num_questions),
                "user_input": user_input,
                "candidate_name": "",
                "asked_questions": [],
                "interview_logs": [],
                "reply_to_user": "",
                "question_for_user": "",
                "current_stage": None, # Agent will use this to start with a greeting
                "_last_question_asked": "",
                "_pending_follow_up_q": ""
            }
        else:
            # This is a SUBSEQUENT TURN. Use the state provided by the client.
            current_state = state
            current_state['user_input'] = user_input

        # --- Invoke Agent Logic ---
        # Pass the complete current state to the agent's invoke method.
        # The agent processes the input, updates the state, and determines the next action.
        new_state = agent_system.invoke(current_state)

        # The agent's response IS the new state. The frontend will use the
        # 'reply_to_user' and 'question_for_user' keys to display messages
        # and will store the entire `new_state` object for the next turn.
        return JsonResponse(new_state)

    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON format in request body.'}, status=400)
    except FileNotFoundError as e:
        return JsonResponse({'error': f'A required data file was not found: {e.filename}. Ensure it exists in the agent/data/ directory.'}, status=404)
    except Exception as e:
        # A general error handler for any other unexpected issues.
        # It's recommended to replace print with a proper logging setup.
        print(f"ERROR in interview_turn: {e}")
        return JsonResponse({'error': 'An unexpected internal server error occurred.'}, status=500)