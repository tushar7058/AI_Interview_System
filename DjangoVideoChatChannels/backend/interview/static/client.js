/********************
 * CONFIG CONSTANTS  *
 ********************/
const SILENCE_THRESHOLD = 5000;  // ms of user silence to end a turn (reduced from 7000)
const FINAL_DEBOUNCE_DELAY = 2000; // wait after "final" transcript before committing
const MAX_BACKOFF_MS = 15000;   // cap for exponential backoff
const PING_INTERVAL_MS = 5000;  // WebSocket heartbeat
const STREAM_MAX_SEC = 305;     // provider hard cap (observed)
const ROTATE_BEFORE_SEC = 270;  // proactively rotate before cap (~4.5 min)

/********************
 * GLOBAL STATE      *
 ********************/

let isAgentSpeaking = false;      // prevent echo send silence while agent speaks
let isAgentThinking = false;      // send silence while agent thinks
let isWaitingForUserResponse = false; // NEW: track if we're waiting for user input
let interviewState = null;        // server-synchronized interview FSM state

let localStream, peerConnection;
let username = "";
let socket = null;                 // signaling WS
let transcriptionSocket = null;    // transcription WS
let dataChannel;

let finalDebounceTimer = null;
let transcriptBuffer = "";        // turn-taking
let inactivityTimer = null;
let lastTranscriptTime = null;    // NEW: track when we last received transcript

let signalingReconnectAttempts = 0;
let transcriptionReconnectAttempts = 0;
let signalingShouldReconnect = true;
let transcriptionShouldReconnect = true;

let signalingPingTimer = null;
let transcriptionPingTimer = null;
let transcriptionRotationTimer = null;

// Message queue so agent messages never overlap in TTS
const messageQueue = [];
let queueProcessing = false;

/********************
 * UTILITIES         *
 ********************/
function expBackoffDelay(attempt) {
  const base = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function enqueueAgentMessage(msg) {
  if (!msg || !msg.trim()) return;
  messageQueue.push(msg);
  processMessageQueue();
}

async function processMessageQueue() {
  if (queueProcessing) return;
  queueProcessing = true;
  try {
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      await displayAndSpeakAgentMessage(msg);
    }
  } finally {
    queueProcessing = false;
    // After agent finishes speaking, we're now waiting for user response
    isWaitingForUserResponse = true;
    console.log("🎤 Agent finished speaking. Waiting for user response...");
  }
}

/********************
 * ENHANCED TRANSCRIPT HANDLER *
 ********************/
function handleTranscriptPacket(data) {
  // Only process transcripts from the user
  if (data.sender !== username) return;
  
  // If agent is speaking or thinking, ignore user input to prevent interruption
  if (isAgentSpeaking || isAgentThinking) {
    console.log("🔇 Ignoring user input while agent is speaking/thinking");
    return;
  }

  // Update last transcript time
  lastTranscriptTime = Date.now();
  
  // Clear any existing timers
  clearTimeout(inactivityTimer);
  clearTimeout(finalDebounceTimer);

  // If we weren't waiting for user response and they start speaking, 
  // this might be an interruption - handle gracefully
  if (!isWaitingForUserResponse && transcriptBuffer.trim() === "") {
    console.log("👂 User started speaking unexpectedly. Listening...");
    isWaitingForUserResponse = true;
  }

  // Add the new text to buffer
  const newText = (data.text || "").trim();
  if (newText) {
    transcriptBuffer += newText + " ";
    
    // Update the live transcript display
    updateLiveTranscript();
    
    console.log("📝 User speaking:", newText);
  }

  // Handle final vs interim transcripts
  if (data.final) {
    console.log("✅ Received final transcript segment");
    // Wait a bit longer after final to make sure user is really done
    finalDebounceTimer = setTimeout(() => {
      commitUserTurn();
    }, FINAL_DEBOUNCE_DELAY);
  } else {
    // For interim transcripts, set shorter silence timer
    inactivityTimer = setTimeout(() => {
      checkIfUserFinishedSpeaking();
    }, SILENCE_THRESHOLD);
  }
}

function updateLiveTranscript() {
  let userTranscriptDiv = document.getElementById('user-transcript-live');
  if (!userTranscriptDiv) {
    userTranscriptDiv = document.createElement('div');
    userTranscriptDiv.id = 'user-transcript-live';
    transcriptBox.appendChild(userTranscriptDiv);
  }
  
  const displayText = transcriptBuffer.trim() || "[listening...]";
  userTranscriptDiv.innerHTML = `<b>You:</b> <span class="text-gray-400">${escapeHtml(displayText)}</span>`;
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function checkIfUserFinishedSpeaking() {
  const timeSinceLastTranscript = Date.now() - (lastTranscriptTime || 0);
  
  if (timeSinceLastTranscript >= SILENCE_THRESHOLD) {
    console.log("🤫 User appears to have stopped speaking due to silence");
    commitUserTurn();
  } else {
    // Check again after a short delay
    inactivityTimer = setTimeout(checkIfUserFinishedSpeaking, 500);
  }
}

function commitUserTurn() {
  const finalTranscript = transcriptBuffer.trim();
  
  // Clear all timers
  clearTimeout(inactivityTimer);
  clearTimeout(finalDebounceTimer);
  
  console.log("✅ User turn committed:", finalTranscript || "[empty/silent]");
  
  // Update the transcript display with final version
  const userTranscriptDiv = document.getElementById('user-transcript-live');
  if (userTranscriptDiv) {
    const displayText = finalTranscript || "[No response]";
    userTranscriptDiv.innerHTML = `<b>You:</b> ${escapeHtml(displayText)}`;
    userTranscriptDiv.id = ''; // Remove 'live' id to mark as final
  }

  // Reset state
  transcriptBuffer = "";
  isWaitingForUserResponse = false;
  
  // Send to agent
  fetchAgentResponse(finalTranscript);
}

/********************
 * BACKEND TURN API  *
 ********************/
async function fetchAgentResponse(text) {
  console.log("🤖 Getting agent response for:", text || "[empty]");
  setAgentThinking(true);
  
  try {
    const response = await fetch("/turn/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: interviewState, userInput: text }),
      credentials: "same-origin",
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Server returned an error page:", errorText);
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    interviewState = await response.json();

    const agentReply = interviewState.reply_to_user;
    const agentQuestion = interviewState.question_for_user;

    // Queue agent messages - they will be spoken in order
    if (agentReply) {
      console.log("💬 Agent reply:", agentReply);
      enqueueAgentMessage(agentReply);
    }

    // Check if interview is done
    if (interviewState.current_stage === 'done') {
      console.log("🏁 Interview has concluded.");
      if (agentQuestion) {
        enqueueAgentMessage(agentQuestion);
      }
      // Stop transcription and disable controls
      stopTranscription();
      return;
    }

    // Queue the next question
    if (agentQuestion) {
      console.log("❓ Agent question:", agentQuestion);
      enqueueAgentMessage(agentQuestion);
    }

  } catch (err) {
    console.error("⚠️ Failed to get agent response:", err);
    enqueueAgentMessage("I seem to have encountered a connection issue. Let's try that again.");
  } finally {
    setAgentThinking(false);
  }
}

function stopTranscription() {
  transcriptionShouldReconnect = false;
  try { 
    if (transcriptionSocket) transcriptionSocket.close(); 
  } catch(_) {}
  
  if (transcriptionPingTimer) {
    clearInterval(transcriptionPingTimer);
    transcriptionPingTimer = null;
  }
  if (transcriptionRotationTimer) {
    clearTimeout(transcriptionRotationTimer);
    transcriptionRotationTimer = null;
  }
  
  // Disable mic button
  micBtn.disabled = true;
  micBtn.classList.add("off");
}

/********************
 * DISPLAY + TTS     *
 ********************/
function displayAndSpeakAgentMessage(msg) {
  return new Promise((resolve) => {
    // Update display immediately
    agentResponseBox.textContent = msg;
    
    // Add to transcript
    const agentMessageDiv = document.createElement('div');
    agentMessageDiv.innerHTML = `<b>Agent:</b> ${escapeHtml(msg)}`;
    transcriptBox.appendChild(agentMessageDiv);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    
    // Speak the message
    speak(msg, resolve);
  });
}

function speak(text, onEndCallback) {
  if (!('speechSynthesis' in window)) {
    console.warn("Speech Synthesis not supported by this browser.");
    if (typeof onEndCallback === 'function') onEndCallback();
    return;
  }
  
  // Cancel any ongoing speech
  try { speechSynthesis.cancel(); } catch (_) {}

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US"; // Changed from "en-IN" for better compatibility
  utterance.rate = 0.9;     // Slightly slower for better comprehension
  utterance.pitch = 1.0;

  utterance.onstart = () => {
    isAgentSpeaking = true;
    agentAvatar.classList.add("speaking");
    console.log("🗣️ Agent started speaking:", text.substring(0, 50) + "...");
  };

  utterance.onend = () => {
    isAgentSpeaking = false;
    agentAvatar.classList.remove("speaking");
    console.log("🔇 Agent finished speaking");
    if (typeof onEndCallback === 'function') onEndCallback();
  };

  utterance.onerror = (e) => {
    console.error("Speech Synthesis Error:", e);
    isAgentSpeaking = false;
    agentAvatar.classList.remove("speaking");
    if (typeof onEndCallback === 'function') onEndCallback();
  };

  speechSynthesis.speak(utterance);
}

function setAgentThinking(isThinking) {
  isAgentThinking = isThinking;
  
  if (isThinking) {
    agentAvatar.classList.add("thinking");
    agentResponseBox.textContent = "Thinking...";
    console.log("🤔 Agent is thinking...");
  } else {
    agentAvatar.classList.remove("thinking");
    console.log("💭 Agent finished thinking");
  }
}

/********************
 * AUDIO PUMP        *
 ********************/
function startTranscription() {
  if (!localStream || localStream.getAudioTracks().length === 0 || !(window.AudioContext || window.webkitAudioContext)) {
    console.warn("Cannot start transcription: missing audio stream or Web Audio API");
    return;
  }
  
  const AC = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AC();
  const source = audioContext.createMediaStreamSource(localStream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  
  source.connect(processor);
  processor.connect(audioContext.destination);

  processor.onaudioprocess = (e) => {
    if (!(transcriptionSocket && transcriptionSocket.readyState === WebSocket.OPEN)) return;

    const isMicEnabled = localStream.getAudioTracks()[0]?.enabled;
    const inputData = e.inputBuffer.getChannelData(0);
    const int16Buffer = new Int16Array(inputData.length);

    // Send silence when:
    // 1. Mic is muted
    // 2. Agent is speaking (to prevent echo)
    // 3. Agent is thinking (to prevent interruption)
    if (!isMicEnabled || isAgentSpeaking || isAgentThinking) {
      for (let i = 0; i < int16Buffer.length; i++) int16Buffer[i] = 0;
    } else {
      // Send actual audio data
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
    }

    try {
      transcriptionSocket.send(int16Buffer.buffer);
    } catch (err) {
      console.warn("Failed to send audio data:", err);
    }
  };

  console.log("🎙️ Transcription started");
}

// ... [Rest of the code remains the same - WebSocket connections, UI controls, etc.]

/********************
 * SIGNALING WS      *
 ********************/
function connectSignalingWS(url) {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  socket = new WebSocket(url);

  socket.onopen = () => {
    signalingReconnectAttempts = 0;
    console.log("🟢 Signaling WebSocket connected.");
    if (signalingPingTimer) clearInterval(signalingPingTimer);
    signalingPingTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
      }
    }, PING_INTERVAL_MS);
    send({ type: "join", username, meetingId });
  };

  socket.onmessage = handleSignalingMessage;

  socket.onerror = (err) => {
    console.warn("Signaling WebSocket error:", err);
  };

  socket.onclose = () => {
    if (signalingPingTimer) { clearInterval(signalingPingTimer); signalingPingTimer = null; }
    if (!signalingShouldReconnect) return;
    const delay = expBackoffDelay(signalingReconnectAttempts++);
    console.log(`🔁 Reconnecting signaling in ${delay}ms...`);
    setTimeout(() => connectSignalingWS(url), delay);
  };
}

function send(msg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn("Signaling socket not open; message queued for retry:", msg.type);
    setTimeout(() => send(msg), 500);
    return;
  }
  socket.send(JSON.stringify({ ...msg, username, meetingId }));
}

function handleSignalingMessage({ data }) {
  const msg = JSON.parse(data);

  if (msg.type === "offer" && msg.to === username) {
    if (!peerConnection) createPeerConnection();
    addLocalTracks();
    peerConnection.ondatachannel = (e) => { dataChannel = e.channel; setupDataChannel(); };
    peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer))
      .then(() => peerConnection.createAnswer())
      .then((answer) => peerConnection.setLocalDescription(answer))
      .then(() => send({ type: "answer", answer: peerConnection.localDescription, to: remoteUsername }))
      .catch(console.error);
  }

  if (msg.type === "candidate" && msg.to === username) {
    if (peerConnection) peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(console.error);
  }
}

function createPeerConnection() {
  const servers = { iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ]};
  peerConnection = new RTCPeerConnection(servers);
  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "candidate", candidate, to: remoteUsername });
  };
  peerConnection.ontrack = ({ track, streams }) => {
    if (track.kind === 'audio') {
      console.log("📥 Received remote audio stream.");
      const remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.srcObject = streams[0];
      document.body.appendChild(remoteAudio);
    }
  };
}

function addLocalTracks() {
  localStream.getTracks().forEach((track) => {
    if (!peerConnection.getSenders().find(s => s.track === track)) {
      peerConnection.addTrack(track, localStream);
    }
  });
}

/********************
 * TRANSCRIPTION WS  *
 ********************/
function connectTranscriptionWS(url) {
  if (transcriptionSocket && transcriptionSocket.readyState === WebSocket.OPEN) return;
  transcriptionSocket = new WebSocket(url);
  transcriptionSocket.binaryType = "arraybuffer";

  transcriptionSocket.onopen = () => {
    transcriptionReconnectAttempts = 0;
    console.log("🟢 Transcription WebSocket connected.");

    if (transcriptionPingTimer) clearInterval(transcriptionPingTimer);
    transcriptionPingTimer = setInterval(() => {
      if (transcriptionSocket?.readyState === WebSocket.OPEN) {
        try { transcriptionSocket.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
      }
    }, PING_INTERVAL_MS);

    if (transcriptionRotationTimer) clearTimeout(transcriptionRotationTimer);
    transcriptionRotationTimer = setTimeout(() => {
      console.log(`⏳ Rotating transcription stream before ${STREAM_MAX_SEC}s cap...`);
      forceRotateTranscription(url);
    }, ROTATE_BEFORE_SEC * 1000);
  };

  transcriptionSocket.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      if (parsed && parsed.type) {
        if (parsed.type === 'error' && /exceeded|timeout|duration/i.test(parsed.message || '')) {
          console.warn('🔴 Provider duration limit hit. Rotating now.');
          forceRotateTranscription(url);
          return;
        }
        if (parsed.type === 'transcript') {
          handleTranscriptPacket(parsed);
          return;
        }
      }
    } catch (_) {}
  };

  transcriptionSocket.onerror = (err) => {
    console.warn("Transcription WebSocket error:", err);
  };

  transcriptionSocket.onclose = () => {
    if (transcriptionPingTimer) { clearInterval(transcriptionPingTimer); transcriptionPingTimer = null; }
    if (transcriptionRotationTimer) { clearTimeout(transcriptionRotationTimer); transcriptionRotationTimer = null; }
    if (!transcriptionShouldReconnect) return;
    const delay = expBackoffDelay(transcriptionReconnectAttempts++);
    console.log(`🔁 Reconnecting transcription in ${delay}ms...`);
    setTimeout(() => connectTranscriptionWS(url), delay);
  };
}

function forceRotateTranscription(url) {
  try { transcriptionSocket.onclose = null; } catch(_) {}
  try { transcriptionSocket.close(); } catch(_) {}
  if (transcriptionPingTimer) { clearInterval(transcriptionPingTimer); transcriptionPingTimer = null; }
  if (transcriptionRotationTimer) { clearTimeout(transcriptionRotationTimer); transcriptionRotationTimer = null; }
  setTimeout(() => {
    transcriptionReconnectAttempts = 0;
    connectTranscriptionWS(url);
  }, 250);
}

/********************
 * DOM ELEMENTS & UI *
 ********************/
const localVideo = document.getElementById("localVideo");
const agentAvatar = document.getElementById("agentAvatar");
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
const meetingId = urlParams.get('meeting') || `interview_${Date.now()}`;
const remoteUsername = "Agent";

/********************
 * JOIN FLOW         *
 ********************/
joinBtn.onclick = async () => {
  username = usernameInput.value.trim();
  if (!username) {
    alert("Please enter your name to begin.");
    return;
  }
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
    alert("Could not access camera or microphone. Please check permissions.");
    return;
  }

  const wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
  const transcribeURL = `${wsProtocol}${location.host}/ws/transcribe/?username=${encodeURIComponent(username)}&meetingId=${encodeURIComponent(meetingId)}`;
  const signalingURL = `${wsProtocol}${location.host}/ws/signaling/`;

  connectTranscriptionWS(transcribeURL);
  connectSignalingWS(signalingURL);
  startTranscription();

  // Start interview with first empty-turn call
  console.log("🚀 Starting interview...");
  await fetchAgentResponse("");
}

/********************
 * DATA CHANNEL      *
 ********************/
function setupDataChannel() {
  if (!dataChannel) return;
  dataChannel.onopen = () => console.log("🟢 DataChannel open");
  dataChannel.onmessage = (e) => console.log("📨 DataChannel:", e.data);
  dataChannel.onerror = (e) => console.warn("DataChannel error:", e);
  dataChannel.onclose = () => console.log("🔴 DataChannel closed");
}

/********************
 * UI CONTROLS       *
 ********************/
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

endBtn.onclick = () => {
  signalingShouldReconnect = false;
  transcriptionShouldReconnect = false;
  try { if (peerConnection) peerConnection.close(); } catch(e) {}
  try { if (socket) socket.close(); } catch(e) {}
  try { if (transcriptionSocket) transcriptionSocket.close(); } catch(e) {}
  if (signalingPingTimer) clearInterval(signalingPingTimer);
  if (transcriptionPingTimer) clearInterval(transcriptionPingTimer);
  if (transcriptionRotationTimer) clearTimeout(transcriptionRotationTimer);
  window.location.href = "/";
};