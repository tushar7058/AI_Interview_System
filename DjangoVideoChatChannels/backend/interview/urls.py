from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),                     # Frontend UI
    path('transcribe/', views.transcribe, name='transcribe'),  # Client-side STT

    # Agent-driven endpoints
    path('start_interview/', views.start_interview, name='start_interview'),
    path('send_answer/', views.send_answer, name='send_answer'),
]