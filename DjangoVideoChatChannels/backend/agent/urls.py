from django.urls import path
from . import views

urlpatterns = [
    path('start/', views.start_interview, name='start_interview'),
    path('send_answer/', views.send_answer, name='send_answer'),
]