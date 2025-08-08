from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.http import JsonResponse
from agent.agent import CustomAutoGenInterviewSystem  # <- Imported from agent app
import json

# Simple global session (can be extended per user)
interview_session = None

def index(request):
    return render(request, 'index.html')

@csrf_exempt
def transcribe(request):
    if request.method == 'POST':
        return JsonResponse({"status": "received"})
    return JsonResponse({"error": "Invalid request"}, status=400)

@csrf_exempt
def start_interview(request):
    """
    Initializes interview session and returns first question.
    """
    global interview_session

    if request.method == 'POST':
        interview_session = CustomAutoGenInterviewSystem()
        return JsonResponse({
            "reply": "Please introduce yourself.",
            "question": "Tell us about yourself.",
            "stage": "greeting"
        })

    return JsonResponse({"error": "Invalid method. Use POST."}, status=405)

@csrf_exempt
def send_answer(request):
    """
    Processes user's answer and returns AI agent's next question.
    """
    global interview_session

    if request.method != 'POST':
        return JsonResponse({"error": "Invalid method. Use POST."}, status=405)

    if not interview_session:
        return JsonResponse({"error": "Interview not started."}, status=400)

    try:
        data = json.loads(request.body)
        answer = data.get("answer", "").strip()
        response = interview_session.get_next(answer)
        return JsonResponse(response)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)