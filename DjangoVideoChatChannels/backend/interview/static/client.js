// Global variables for the WebRTC connection
let localStream, peerConnection;
let username = "";
let socket, transcriptionSocket, dataChannel;

// --- NEW: Variables for improved turn-taking ---
let transcriptBuffer = ""; // To accumulate text during a user's turn
let inactivityTimer = null;  // To track silence from the user
const SILENCE_THRESHOLD = 1500; // 1.5 seconds of silence indicates the end of a turn

// WebRTC STUN servers
const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// DOM Elements
const localVideo = document.getElementById("localVideo");
const agentAvatar = document.getElementById("agentAvatar"); // Using the static avatar
const transcriptBox = document.getElementById("transcript");
const agentResponseBox = document.getElementById("agent-response");
const camBtn = document.getElementById("camBtn");
const micBtn = document.getElementById("micBtn");
const screenBtn = document.getElementById("screenBtn");
const chatBtn = document.getElementById("chatBtn");
const endBtn = document.getElementById("endBtn");
const chatBox = document.getElementById("chatBox");
const messages = document.getElementById("messages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const joinBtn = document.getElementById("joinBtn");
const usernameInput = document.getElementById("usernameInput");
const usernamePrompt = document.getElementById("usernamePrompt");

const urlParams = new URLSearchParams(window.location.search);
const meetingId = urlParams.get('meeting') || 'default_room';
const remoteUsername = "Agent";

joinBtn.onclick = async () => {
  username = usernameInput.value.trim();
  if (!username) return alert("Please enter your name");
  usernamePrompt.style.display = "none";
  document.getElementById("localName").textContent = username;
  await start();
};

async function start() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (err) {
    console.error("❌ Error accessing camera/microphone:", err);
    return;
  }

  const wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
  transcriptionSocket = new WebSocket(`${wsProtocol}${location.host}/ws/transcribe/?username=${username}&meetingId=${meetingId}`);
  transcriptionSocket.onopen = () => console.log("🟢 Transcription WebSocket connected.");
  transcriptionSocket.onmessage = handleTranscriptionMessage;

  socket = new WebSocket(`${wsProtocol}${location.host}/ws/signaling/`);
  socket.onopen = () => {
    send({ type: "join", username, meetingId });
  };
  socket.onmessage = handleSignalingMessage;

  startTranscription();
  await fetchAgentResponse(""); // Kick off the interview
}

function send(msg) {
  socket.send(JSON.stringify({ ...msg, username, meetingId }));
}

function handleSignalingMessage({ data }) {
  const msg = JSON.parse(data);

  if (msg.type === "offer" && msg.to === username) {
    createPeerConnection();
    addLocalTracks();
    peerConnection.ondatachannel = (e) => { dataChannel = e.channel; setupDataChannel(); };
    peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer))
      .then(() => peerConnection.createAnswer())
      .then((answer) => {
        peerConnection.setLocalDescription(answer);
        send({ type: "answer", answer, to: remoteUsername });
      });
  }

  if (msg.type === "candidate" && msg.to === username) {
    peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(console.error);
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(servers);
  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "candidate", candidate, to: remoteUsername });
  };

  // --- CHANGED: Handle audio-only stream from agent ---
  peerConnection.ontrack = ({ track, streams }) => {
    if (track.kind === 'audio') {
      console.log("📥 Received remote audio stream from Agent.");
      const remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.srcObject = streams[0];
    }
  };
}

function addLocalTracks() {
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
}

// --- NEW: Handles incoming transcription with silence detection ---
function handleTranscriptionMessage(event) {
  const data = JSON.parse(event.data);
  if (data.type !== "transcript" || data.sender !== username) return;

  // As user speaks, clear any existing timer
  clearTimeout(inactivityTimer);

  // Append new text to our buffer
  transcriptBuffer += data.text + " ";
  
  // Display live transcription to the user
  const userTranscriptDiv = document.getElementById('user-transcript-live') || document.createElement('div');
  userTranscriptDiv.id = 'user-transcript-live';
  userTranscriptDiv.innerHTML = `<b>${username} (You):</b> ${transcriptBuffer}`;
  if (!document.getElementById('user-transcript-live')) {
    transcriptBox.appendChild(userTranscriptDiv);
  }
  transcriptBox.scrollTop = transcriptBox.scrollHeight;

  // Set a timer. If it fires, the user has stopped talking.
  inactivityTimer = setTimeout(() => {
    if (transcriptBuffer.trim().length > 0) {
      console.log("✅ User finished speaking. Sending:", transcriptBuffer.trim());
      // Make the live transcript permanent
      userTranscriptDiv.id = '';
      // Send the complete thought to the agent
      fetchAgentResponse(transcriptBuffer.trim());
    }
    // Clear the buffer for the next turn
    transcriptBuffer = "";
  }, SILENCE_THRESHOLD);
}

// --- NEW: Handles interview ending and conversational flow ---
async function fetchAgentResponse(text) {
  try {
    const res = await fetch("/agent/send_answer/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: text, meetingId, username }),
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || "Server responded with an error");
    }

    const data = await res.json();

    // Display the agent's immediate reply (feedback on previous answer)
    if (data.reply) {
      displayAgentMessage(data.reply);
    }

    // Check if the interview is over
    if (data.stage === 'done') {
      console.log("🏁 Interview has concluded.");
      if (transcriptionSocket) {
        transcriptionSocket.onmessage = null; // Stop listening for new transcripts
      }
      micBtn.disabled = true;
      micBtn.classList.add("off");
      return; // End the interaction
    }

    // If there is a follow-up question, ask it after a short delay
    if (data.question) {
      setTimeout(() => {
        displayAgentMessage(data.question);
      }, 1200); // Delay for more natural pacing
    }
  } catch (err) {
    console.error("⚠️ Failed to get agent response:", err);
    displayAgentMessage("Sorry, I encountered an error. Please try again.");
  }
}

// Displays the agent's message on the screen and speaks it
function displayAgentMessage(msg) {
  agentResponseBox.innerHTML = msg;
  transcriptBox.innerHTML += `<div><b>Agent:</b> ${msg}</div>`;
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
  speak(msg);
}

function speak(text) {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-IN";
  utterance.rate = 1.0;
  
  utterance.onstart = () => agentAvatar.classList.add("speaking");
  utterance.onend = () => agentAvatar.classList.remove("speaking");
  utterance.onerror = () => agentAvatar.classList.remove("speaking");
  
  speechSynthesis.speak(utterance);
}

function startTranscription() {
  const audioContext = new AudioContext();
  if (!localStream || localStream.getAudioTracks().length === 0) return;
  const source = audioContext.createMediaStreamSource(localStream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(audioContext.destination);
  processor.onaudioprocess = (e) => {
    if (transcriptionSocket && transcriptionSocket.readyState === WebSocket.OPEN) {
      const input = e.inputBuffer.getChannelData(0);
      const buffer = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) buffer[i] = Math.min(1, input[i]) * 0x7FFF;
      transcriptionSocket.send(buffer.buffer);
    }
  };
}

// --- UI Control Button Logic (unchanged) ---
// (The rest of your UI button functions remain the same)
sendBtn.onclick = () => {
  const msg = chatInput.value.trim();
  if (msg && dataChannel && dataChannel.readyState === 'open') {
    messages.innerHTML += `<div><b>You:</b> ${msg}</div>`;
    messages.scrollTop = messages.scrollHeight;
    dataChannel.send(JSON.stringify({ type: "chat", message: msg }));
    chatInput.value = "";
  }
};
chatInput.oninput = () => {
  if (dataChannel && dataChannel.readyState === 'open') dataChannel.send(JSON.stringify({ type: "typing" }));
};
camBtn.onclick = () => {
  const track = localStream.getVideoTracks()[0];
  track.enabled = !track.enabled;
  camBtn.classList.toggle("off", !track.enabled);
};
micBtn.onclick = () => {
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  micBtn.classList.toggle("off", !track.enabled);
};
screenBtn.onclick = async () => {
  const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  const screenTrack = screenStream.getVideoTracks()[0];
  const sender = peerConnection.getSenders().find((s) => s.track.kind === "video");
  sender?.replaceTrack(screenTrack);
  screenTrack.onended = () => sender?.replaceTrack(localStream.getVideoTracks()[0]);
};
chatBtn.onclick = () => chatBox.style.display = chatBox.style.display === "block" ? "none" : "block";
endBtn.onclick = () => {
  if (peerConnection) peerConnection.close();
  if (socket) socket.close();
  if (transcriptionSocket) transcriptionSocket.close();
  location.reload();
};