from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from .agent import CustomAutoGenInterviewSystem
import json

# A dictionary to hold multiple, simultaneous interview sessions.
# The key will be the 'meetingId'.
interview_sessions = {}

@csrf_exempt
def handle_interview(request):
    """
    This single view handles the entire interview process.
    - It creates a new interview session if one doesn't exist for the meetingId.
    - It processes the candidate's transcript and returns the agent's next response.
    """
    if request.method != 'POST':
        return JsonResponse({"error": "Invalid request method. Use POST."}, status=405)

    try:
        data = json.loads(request.body)
        transcript = data.get("transcript", "").strip()
        meeting_id = data.get("meetingId")

        if not meeting_id:
            return JsonResponse({"error": "meetingId is required."}, status=400)

        # Get the session for this specific meeting, or create a new one if it's the first message.
        if meeting_id not in interview_sessions:
            print(f"INFO: Creating new interview session for meeting: {meeting_id}")
            interview_sessions[meeting_id] = CustomAutoGenInterviewSystem()
            # For the very first turn, the transcript will be empty.
            # The agent should be designed to handle this and provide a greeting.
        
        # Use the session specific to this meeting
        current_session = interview_sessions[meeting_id]
        response = current_session.get_next(transcript)

        # Clean up finished sessions to save memory (optional but good practice)
        if response.get("stage") == "finished":
            print(f"INFO: Deleting finished session for meeting: {meeting_id}")
            del interview_sessions[meeting_id]

        return JsonResponse({
            "reply": response.get("reply", ""),
            "question": response.get("question", "Is there anything else you'd like to discuss?"),
            "stage": response.get("stage", "questioning")
        })

    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON format in request body."}, status=400)
    except Exception as e:
        return JsonResponse({"error": f"An internal error occurred: {str(e)}"}, status=500)