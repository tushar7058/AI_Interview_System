# interview/routing.py

from django.urls import re_path
from . import consumers
from . import transcription_consumer

websocket_urlpatterns = [
    re_path(r'ws/signaling/$', consumers.SignalingConsumer.as_asgi()),
    re_path(r'ws/transcribe/$', transcription_consumer.TranscriptionConsumer.as_asgi()),
    
]