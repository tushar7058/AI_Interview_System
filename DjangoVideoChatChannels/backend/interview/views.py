# interview/views.py

import json
from django.shortcuts import render
from django.views.decorators.http import require_POST
from django.views.decorators.csrf import csrf_exempt
from django.http import JsonResponse
from agent.agent import AgenticInterviewSystem, read_file

# --- Agent Initialization ---
# The agent is instantiated once at startup and is completely stateless.
agent_system = AgenticInterviewSystem()

def index(request):
    """Renders the main interview page."""
    return render(request, 'index.html')

@csrf_exempt
@require_POST
def handle_interview_turn(request):
    """
    Handles a single, stateless turn of the interview.

    This view receives the entire current interview state from the client,
    invokes the agent to process the user's input, and returns the
    complete, updated state back to the client.
    """
    try:
        data = json.loads(request.body)
        state = data.get('state')
        user_input = data.get('userInput', '')

        # --- State Management ---
        if state is None:
            # First turn: Initialize the state for a new interview.
            # In a real app, you might get these filenames from the request.
            print("INFO: Initializing new interview state.")
            current_state = {
                "job_description": read_file("software_engineer_jd.txt"),
                "resume": read_file("candidate_resume.txt"),
                "num_questions_total": 5,
                "user_input": user_input,
            }
        else:
            # Subsequent turns: Use the state provided by the client.
            current_state = state
            current_state['user_input'] = user_input

        # --- Invoke Agent Logic ---
        # The view correctly calls the agent's 'invoke' method with the full state.
        new_state = agent_system.invoke(current_state)

        return JsonResponse(new_state)

    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON in request body.'}, status=400)
    except FileNotFoundError as e:
        return JsonResponse({
            'error': f'A required data file was not found: {e.filename}. Please ensure it is in the agent/data/ directory.'
        }, status=404)
    except Exception as e:
        # Log the full error for easier debugging on the server.
        print(f"ERROR in handle_interview_turn: {type(e).__name__}: {e}")
        return JsonResponse({'error': 'An internal server error occurred.'}, status=500)