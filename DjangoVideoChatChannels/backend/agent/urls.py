# backend/agent/urls.py
from django.urls import path
from . import views

urlpatterns = [
    path('interview-turn/', views.interview_turn, name='interview_turn'),
]