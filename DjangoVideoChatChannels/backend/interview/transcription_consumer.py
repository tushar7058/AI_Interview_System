import asyncio
import json
import threading
import queue
from urllib.parse import parse_qs

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.layers import get_channel_layer
from google.cloud import speech_v1p1beta1 as speech
from google.oauth2 import service_account
from asgiref.sync import async_to_sync



class TranscriptionConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.audio_queue = asyncio.Queue()
        self.buffer = queue.Queue()
        self.stop_event = threading.Event()
        self.username = "Anonymous"
        self.room_group_name = "transcription_room"

    async def connect(self):
        query_params = parse_qs(self.scope["query_string"].decode())
        self.username = query_params.get("username", ["Anonymous"])[0]
        print(f"✅ WebSocket connected for user: {self.username}")

        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept()

        self.loop = asyncio.get_event_loop()  # ✅ FIX HERE
        print(f"✅ WebSocket connected for user: {self.username}")

        self.transcription_task = asyncio.create_task(self.handle_audio())
        self.thread = threading.Thread(target=self.start_transcription)
        self.thread.start()


    async def disconnect(self, close_code):
        print(f"🔌 WebSocket disconnected: {self.username}")
        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
        self.stop_event.set()
        self.transcription_task.cancel()

    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data:
            await self.audio_queue.put(bytes_data)

    async def handle_audio(self):
        while not self.stop_event.is_set():
            try:
                data = await self.audio_queue.get()
                self.buffer.put(data)
            except Exception as e:
                print("❌ Audio handling error:", e)

    def start_transcription(self):
        credentials = service_account.Credentials.from_service_account_file("key.json")
        client = speech.SpeechClient(credentials=credentials)

        config = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=44100,
            language_code="en-US",
            enable_automatic_punctuation=True,
        )

        streaming_config = speech.StreamingRecognitionConfig(
            config=config,
            interim_results=False,
            single_utterance=False,
        )

        def request_generator():
            while not self.stop_event.is_set():
                try:
                    chunk = self.buffer.get(timeout=1)
                    yield speech.StreamingRecognizeRequest(audio_content=chunk)
                except queue.Empty:
                    continue

        print(f"🎙️ Starting transcription for {self.username}")
        try:
            responses = client.streaming_recognize(streaming_config, request_generator())
           

            last_final_transcript = ""
 
            for response in responses:
                if not response.results:
                    continue
                result = response.results[0]
                if result.is_final:
                        transcript = result.alternatives[0].transcript.strip()
                        if transcript and transcript != last_final_transcript:
                            last_final_transcript = transcript
                            print("📝 FINAL:", transcript)
                            asyncio.run_coroutine_threadsafe(self.send_transcript(transcript), self.loop)



        except Exception as e:
            print("❌ Transcription error:", e)

    async def send_transcript(self, text):
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "broadcast_transcript",
                "text": text,
                "sender": self.username
                
            }
        )

    async def broadcast_transcript(self, event):
        await self.send(text_data=json.dumps({
            "type": "transcript",
            "text": event["text"],
            "sender": event["sender"]
            
        }))
