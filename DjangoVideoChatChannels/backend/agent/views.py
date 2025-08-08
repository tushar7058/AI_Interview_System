from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from .agent import CustomAutoGenInterviewSystem
import json

# Simple in-memory global session (single-user only)
interview_session = None

@csrf_exempt
def start_interview(request):
    """
    Initializes a new interview session and returns the first question.
    """
    global interview_session

    if request.method == 'POST':
        interview_session = CustomAutoGenInterviewSystem()

        # Start the interview with the first system-generated question
        initial_response = interview_session.get_next("")  # empty string = trigger first question

        return JsonResponse({
            "reply": initial_response.get("reply", "Let's begin."),
            "question": initial_response.get("question", "Tell me about yourself."),
            "stage": initial_response.get("stage", "greeting")
        })

    return JsonResponse({"error": "Invalid request method. Use POST."}, status=405)


@csrf_exempt
def send_answer(request):
    """
    Accepts the transcript (candidate's spoken response),
    and returns the AI agent's next question.
    """
    global interview_session

    if request.method != 'POST':
        return JsonResponse({"error": "Invalid request method. Use POST."}, status=405)

    if not interview_session:
        return JsonResponse({"error": "Interview not started. Call /start_interview/ first."}, status=400)

        try:
            data = json.loads(request.body)
            transcript = data.get("transcript", "").strip()

            if not transcript:
                return JsonResponse({"error": "Transcript is empty."}, status=400)

            response = interview_session.get_next(transcript)

            return JsonResponse({
                "reply": response.get("reply", ""),
                "question": response.get("question", ""),
                "stage": response.get("stage", "questioning")
            })

        except Exception as e:
            return JsonResponse({"error": str(e)}, status=500)