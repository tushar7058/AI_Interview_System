# agent/urls.py
from django.urls import path
from . import views

urlpatterns = [
    # The 'send_answer' URL now handles the entire interview flow
    path('send_answer/', views.handle_interview, name='handle_interview'),
]