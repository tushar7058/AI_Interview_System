
/********************
 * CONFIG CONSTANTS  *
 ********************/
const SILENCE_THRESHOLD = 7000 ; // ms of user silence to end a turn
const MAX_BACKOFF_MS = 15000;   // cap for exponential backoff
const PING_INTERVAL_MS = 5000;  // WebSocket heartbeat
const STREAM_MAX_SEC = 305;     // provider hard cap (observed)
const ROTATE_BEFORE_SEC = 270;  // proactively rotate before cap (~4.5 min)

/********************
 * GLOBAL STATE      *
 ********************/

let isAgentSpeaking = false;      // prevent echo send silence while agent speaks
let isAgentThinking = false;      // send silence while agent thinks :->
let interviewState = null;        // server-synchronized interview FSM state

let localStream, peerConnection;
let username = "";
let socket = null;                 // signaling WS
let transcriptionSocket = null;    // transcription WS
let dataChannel;



let finalDebounceTimer = null;  // <-- declare once globally with transcriptBuffer

let transcriptBuffer = "";        // turn-taking
let inactivityTimer = null;

let signalingReconnectAttempts = 0;
let transcriptionReconnectAttempts = 0;
let signalingShouldReconnect = true;
let transcriptionShouldReconnect = true;

let signalingPingTimer = null;
let transcriptionPingTimer = null;
let transcriptionRotationTimer = null; // proactively rotate stream

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
  }
}

/********************
 * DOM ELEMENTS      *
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

  // start interview with first empty-turn call
  await fetchAgentResponse("");
}

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
    if (peerConnection) peerConnection.addIceCandidate(new RTCRtpReceiver.supportedAlgorithms ? msg.candidate : new RTCIceCandidate(msg.candidate)).catch(console.error);
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

    // Heartbeat
    if (transcriptionPingTimer) clearInterval(transcriptionPingTimer);
    transcriptionPingTimer = setInterval(() => {
      if (transcriptionSocket?.readyState === WebSocket.OPEN) {
        try { transcriptionSocket.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
      }
    }, PING_INTERVAL_MS);

    // Proactive rotation before hard cap
    if (transcriptionRotationTimer) clearTimeout(transcriptionRotationTimer);
    transcriptionRotationTimer = setTimeout(() => {
      console.log(`⏳ Rotating transcription stream before ${STREAM_MAX_SEC}s cap...`);
      forceRotateTranscription(url);
    }, ROTATE_BEFORE_SEC * 1000);
  };

  transcriptionSocket.onmessage = (event) => {
    // Some servers send controls as JSON (errors/timeouts); transcripts also JSON
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
    } catch (_) { /* Non-JSON frames ignored */ }
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
  // Close quietly and reconnect fast
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
 * TRANSCRIPT HANDLER*
 ********************/

function handleTranscriptPacket(data) {
  // Expecting: { type: 'transcript', sender, text, final?: bool }
  if (data.sender !== username) return;
  clearTimeout(inactivityTimer);

  transcriptBuffer += (data.text || "") + " ";

  let userTranscriptDiv = document.getElementById('user-transcript-live');
  if (!userTranscriptDiv) {
    userTranscriptDiv = document.createElement('div');
    userTranscriptDiv.id = 'user-transcript-live';
    transcriptBox.appendChild(userTranscriptDiv);
  }
  userTranscriptDiv.innerHTML = `<b>You:</b> <span class="text-gray-400">${escapeHtml(transcriptBuffer)}</span>`;
  transcriptBox.scrollTop = transcriptBox.scrollHeight;

  // If the packet is marked final, or silence timer fires, we'll commit the turn
  // If the packet is marked final, debounce before committing
  if (data.final) {
    clearTimeout(finalDebounceTimer);
    finalDebounceTimer = setTimeout(() => {
      commitUserTurn();
    }, 5000); // <-- waits 3s after a "final" before committing
  } else {
    // Still reset silence-based inactivity timer
    inactivityTimer = setTimeout(commitUserTurn, SILENCE_THRESHOLD);
  }
}

function commitUserTurn() {
  const finalTranscript = transcriptBuffer.trim();
  clearTimeout(inactivityTimer);
  clearTimeout(finalDebounceTimer);

  // Always send a turn — even if empty — to advance the conversation
  console.log("✅ User turn committed. Transcript:", finalTranscript || "[empty]");
  
  // Show "[No response]" in transcript UI if silent
  const userTranscriptDiv = document.getElementById('user-transcript-live');
  if (userTranscriptDiv) {
    userTranscriptDiv.innerHTML = `<b>You:</b> ${escapeHtml(finalTranscript || "[No response]")}`;
    userTranscriptDiv.id = '';
  }

  fetchAgentResponse(finalTranscript); // always call
  transcriptBuffer = "";
}


/********************
 * BACKEND TURN API  *
 ********************/
async function fetchAgentResponse(text) {
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

    if (agentReply) enqueueAgentMessage(agentReply);

    if (interviewState.current_stage === 'done') {
      console.log("🏁 Interview has concluded.");
      if (agentQuestion) enqueueAgentMessage(agentQuestion);
      // stop transcription rotation and input
      transcriptionShouldReconnect = false;
      try { if (transcriptionSocket) transcriptionSocket.close(); } catch(_) {}
      if (transcriptionPingTimer) clearInterval(transcriptionPingTimer);
      if (transcriptionRotationTimer) clearTimeout(transcriptionRotationTimer);
      micBtn.disabled = true;
      micBtn.classList.add("off");
      return;
    }

    if (agentQuestion) enqueueAgentMessage(agentQuestion);
  } catch (err) {
    console.error("⚠️ Failed to get agent response:", err);
    enqueueAgentMessage("I seem to have encountered a connection issue. Let's try that again.");
  } finally {
    setAgentThinking(false);
  }
}

/********************
 * DISPLAY + TTS     *
 ********************/
function displayAndSpeakAgentMessage(msg) {
  return new Promise((resolve) => {
    agentResponseBox.textContent = msg;
    const agentMessageDiv = document.createElement('div');
    agentMessageDiv.innerHTML = `<b>Agent:</b> ${escapeHtml(msg)}`;
    transcriptBox.appendChild(agentMessageDiv);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    speak(msg, resolve);
  });
}

function speak(text, onEndCallback) {
  if (!('speechSynthesis' in window)) {
    console.warn("Speech Synthesis not supported by this browser.");
    if (typeof onEndCallback === 'function') onEndCallback();
    return;
  }
  try { speechSynthesis.cancel(); } catch (_) {}

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-IN";
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  utterance.onstart = () => {
    isAgentSpeaking = true;
    agentAvatar.classList.add("speaking");
  };
  utterance.onend = () => {
    isAgentSpeaking = false;
    agentAvatar.classList.remove("speaking");
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
  isAgentThinking = isThinking; // ADD THIS LINE to update the global state
  if (isThinking) {
    agentAvatar.classList.add("thinking");
    agentResponseBox.textContent = "Thinking...";
  } else {
    agentAvatar.classList.remove("thinking");
  }
}

/********************
 * AUDIO PUMP        *
 ********************/
function startTranscription() {
  if (!localStream || localStream.getAudioTracks().length === 0 || !(window.AudioContext || window.webkitAudioContext)) {
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

    // Send silence when mic is muted OR agent is speaking, to keep the stream alive
    // if (!isMicEnabled || isAgentSpeaking) -> for the stopping transcription while agent thinking.
    if (!isMicEnabled || isAgentSpeaking || isAgentThinking){
      for (let i = 0; i < int16Buffer.length; i++) int16Buffer[i] = 0;
    } else {
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
    }

    try {
      transcriptionSocket.send(int16Buffer.buffer);
    } catch (_) {
      // If send fails due to socket closing, reconnect logic will handle it.
    }
  };
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
