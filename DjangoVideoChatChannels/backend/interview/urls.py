# interview/urls.py

from django.urls import path
from . import views

urlpatterns = [
    # Serves the main HTML page for the interview interface
    path('', views.index, name='index'),

    # A single, unified endpoint to handle every turn of the conversation.
    # This replaces the separate start_interview and send_answer endpoints.
    path('turn/', views.handle_interview_turn, name='handle_interview_turn'),
]